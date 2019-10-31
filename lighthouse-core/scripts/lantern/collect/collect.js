/**
 * @license Copyright 2019 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/** @typedef {import('./common.js').Result} Result */
/** @typedef {import('./common.js').Summary} Summary */
/** @typedef {ReturnType<typeof createTask>} Task */

const fs = require('fs');
const fetch = require('isomorphic-fetch');
const {execFile} = require('child_process');
const {promisify} = require('util');
const execFileAsync = promisify(execFile);
const common = require('./common.js');

const LH_ROOT = `${__dirname}/../../../..`;
const SAMPLES = process.env.SAMPLES ? Number(process.env.SAMPLES) : 9;
const TEST_URLS = process.env.TEST_URLS ? process.env.TEST_URLS.split(' ') : require('./urls.js');

if (!process.env.WPT_KEY) throw new Error('missing WPT_KEY');
const WPT_KEY = process.env.WPT_KEY;
const DEBUG = process.env.DEBUG;

/**
 * @param {string} filename
 * @param {string} data
 */
function saveData(filename, data) {
  fs.mkdirSync(common.collectFolder, {recursive: true});
  fs.writeFileSync(`${common.collectFolder}/${filename}`, data);
  return filename;
}

/**
 * @param {string} url
 * @return {Promise<string>}
 */
async function fetchString(url) {
  const response = await fetch(url);
  if (response.ok) return response.text();
  throw new Error(`error fetching ${url}: ${response.status} ${response.statusText}`);
}

/**
 * @param {string} url
 */
async function startWptTest(url) {
  const apiUrl = new URL('https://www.webpagetest.org/runtest.php');
  apiUrl.search = new URLSearchParams({
    k: WPT_KEY,
    f: 'json',
    url,
    // Keep the location constant. Use Chrome and 3G network conditions.
    // Using Beta because we need 78+ traces for LCP.
    location: 'Dulles_MotoG4:Motorola G (gen 4) - Chrome Beta.3G',
    runs: '1',
    lighthouse: '1',
    // Make the trace file available over /getgzip.php.
    lighthouseTrace: '1',
    // Disable some things that WPT does, such as a "repeat view" analysis.
    type: 'lighthouse',
  }).toString();
  const wptResponseJson = await fetchString(apiUrl.href);
  const wptResponse = JSON.parse(wptResponseJson);
  if (wptResponse.statusCode !== 200) {
    throw new Error(`unexpected status code ${wptResponse.statusCode} ${wptResponse.statusText}`);
  }

  return {
    testId: wptResponse.data.testId,
    jsonUrl: wptResponse.data.jsonUrl,
  };
}

/**
 * @param {string} url
 * @return {Promise<Result>}
 */
async function runUnthrottledLocally(url) {
  const artifactsFolder = `${LH_ROOT}/.tmp/collect-traces-artifacts`;
  const {stdout} = await execFileAsync('node', [
    `${LH_ROOT}/lighthouse-cli`,
    url,
    '--throttling-method=provided',
    '--output=json',
    `-AG=${artifactsFolder}`,
    process.env.NO_OOPIFS === '1' ? '--chrome-flags=--disable-features=site-per-process' : '',
  ], {
    // Default (1024 * 1024) is too small.
    maxBuffer: 10 * 1024 * 1024,
  });
  // Make the JSON small.
  const lhr = JSON.parse(stdout);
  assertLhr(lhr);
  const devtoolsLog = fs.readFileSync(`${artifactsFolder}/defaultPass.devtoolslog.json`, 'utf-8');
  const trace = fs.readFileSync(`${artifactsFolder}/defaultPass.trace.json`, 'utf-8');
  return {
    devtoolsLog,
    lhr: JSON.stringify(lhr),
    trace,
  };
}

/**
 * @param {string} url
 * @param {function():void} startedCb
 * @return {Promise<Result>}
 */
async function runForWpt(url, startedCb) {
  let started = false;
  const {testId, jsonUrl} = await startWptTest(url);
  if (DEBUG) log.log({url, testId, jsonUrl});

  function triggerStarted() {
    if (started) return;
    started = true;
    startedCb();
  }

  // Poll for the results every x seconds, where x = position in queue.
  let lhr;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const responseJson = await fetchString(jsonUrl);
    const response = JSON.parse(responseJson);

    if (response.statusCode === 200) {
      triggerStarted(); // just in case WPT was super fast.
      lhr = response.data.lighthouse;
      assertLhr(lhr);
      break;
    }

    if (response.statusCode >= 100 && response.statusCode < 200) {
      // If behindCount doesn't exist, the test is currently running.
      // * Wait 30 seconds if the test is currently running.
      // * Wait an additional 10 seconds for every test ahead of this one.
      // * Don't wait for more than 10 minutes.
      const secondsToWait = Math.min(30 + 10 * (response.data.behindCount || 0), 10 * 1000);
      if (DEBUG) log.log('poll wpt in', secondsToWait);
      if (!response.data.behindCount) triggerStarted();
      await new Promise((resolve) => setTimeout(resolve, secondsToWait * 1000));
    } else {
      throw new Error(`unexpected response: ${response.statusCode} ${response.statusText}`);
    }
  }

  const traceUrl = new URL('https://www.webpagetest.org/getgzip.php');
  traceUrl.searchParams.set('test', testId);
  traceUrl.searchParams.set('file', 'lighthouse_trace.json');
  const traceJson = await fetchString(traceUrl.href);

  /** @type {LH.Trace} */
  const trace = JSON.parse(traceJson);
  // For some reason, the first trace event is an empty object.
  trace.traceEvents = trace.traceEvents.filter(e => Object.keys(e).length > 0);

  return {
    lhr: JSON.stringify(lhr),
    trace: JSON.stringify(trace),
  };
}

/**
 * @param {() => Promise<Result>} asyncFn
 */
async function repeatUntilPass(asyncFn) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await asyncFn();
    } catch (err) {
      log.log(err, 'error....');
    }
  }
}

/**
 * @param {LH.Result=} lhr
 */
function assertLhr(lhr) {
  if (!lhr) throw new Error('missing lhr');
  if (lhr.runtimeError) throw new Error(`runtime error: ${lhr.runtimeError}`);
  const metrics = common.getMetrics(lhr);
  if (metrics && metrics.interactive && metrics.firstContentfulPaint) return;
  throw new Error('run failed to get metrics for ' + lhr.requestedUrl);
}

/** @type {typeof common.ProgressLogger['prototype']} */
let log;

/**
 * @param {string} url
 */
function createTask(url) {
  const wptResultPromises = [];
  /** @type {Result[]} */
  const wptResults = [];
  /** @type {function():void} */
  let wptStartedPromiseResolve;
  const wptStartedPromise = new Promise(resolve => wptStartedPromiseResolve = resolve);

  // Can run in parallel.
  for (let i = 0; i < SAMPLES; i++) {
    // Just need one promise to notify when WPT begins. It's OK that `resolve` will be
    // called multiple times.
    const resultPromise = repeatUntilPass(() => runForWpt(url, wptStartedPromiseResolve));
    resultPromise.then(result => wptResults.push(result));
    wptResultPromises.push(resultPromise);
  }

  const task = {
    url,
    wptStartedPromise,
    wptResultPromises,
    wptResults,
    unthrottledResults: /** @type {Result[]} */([]),
  };

  return task;
}

/**
 * @param {Task[]} tasks
 * @param {Task} currentTask
 */
function updateProgress(tasks, currentTask) {
  const wptDoneCount = tasks.map(t => t.wptResults.length).reduce((acc, cur) => acc + cur);
  const wptTotalCount = tasks.map(t => t.wptResultPromises.length).reduce((acc, cur) => acc + cur);

  const curTaskWptDoneCount = currentTask.wptResults.length;
  const curTaskWptTotalCount = currentTask.wptResultPromises.length;
  const curTaskWptDone = curTaskWptDoneCount === curTaskWptTotalCount;

  const curTaskUnthrottledDoneCount = currentTask.unthrottledResults.length;
  const curTaskUnthrottledTotalCount = SAMPLES;
  const curTaskUnthrottledDone = curTaskUnthrottledDoneCount === curTaskUnthrottledTotalCount;

  log.progress([
    'all wpt:', `${wptDoneCount} / ${wptTotalCount}`,
    'tasks left:', tasks.length,
    'current task:', currentTask.url,
    'wpt',
    '(' + (curTaskWptDone ? 'DONE' : `${curTaskWptDoneCount + 1} / ${curTaskWptTotalCount}`) + ')',
    'unthrottled',
    // eslint-disable-next-line max-len
    '(' + (curTaskUnthrottledDone ? 'DONE' : `${curTaskUnthrottledDoneCount + 1} / ${curTaskUnthrottledTotalCount}`) + ')',
  ].join(' '));
}

/**
 * @param {Summary[]} summary
 * @param {Task} task
 */
function commit(summary, task) {
  const url = task.url;
  const sanitizedUrl = url.replace(/[^a-z0-9]/gi, '-');
  const urlResultSet = {
    url,
    wpt: task.wptResults.map((result, i) => {
      const prefix = `${sanitizedUrl}-mobile-wpt-${i + 1}`;
      return {
        lhr: saveData(`${prefix}-lhr.json`, result.lhr),
        trace: saveData(`${prefix}-trace.json`, result.trace),
      };
    }),
    unthrottled: task.unthrottledResults.map((result, i) => {
      if (!result.devtoolsLog) throw new Error('expected devtools log');

      const prefix = `${sanitizedUrl}-mobile-unthrottled-${i + 1}`;
      return {
        devtoolsLog: saveData(`${prefix}-devtoolsLog.json`, result.devtoolsLog),
        lhr: saveData(`${prefix}-lhr.json`, result.lhr),
        trace: saveData(`${prefix}-trace.json`, result.trace),
      };
    }),
  };

  // We just collected SAMPLES * 2 traces, so let's save our progress.
  summary.push(urlResultSet);
  common.saveSummary(summary);
}

async function main() {
  log = new common.ProgressLogger();

  // Resume state from previous invocation of script.
  // This script should be run in a single go, but just in case it stops midway
  // this prevents some duplication of work.
  const summary = common.loadSummary()
    // Remove data if no longer in URLS.
    .filter(urlSet => TEST_URLS.includes(urlSet.url));

  fs.mkdirSync(common.collectFolder, {recursive: true});

  const urlsToRun = TEST_URLS.filter(url => {
    // This URL has been done on a previous script invocation. Skip it.
    if (summary.find((urlResultSet) => urlResultSet.url === url)) {
      log.log(`already collected traces for ${url}`);
      return false;
    }

    return true;
  });

  // WPT requests made through the API are low priority, so we fire all of them at once.
  // To ensure that local runs are collected near the same time that WPT renders it,
  // the local runs for a URL only start after the first WPT run for that URL begins.
  // To do this, we make a task for every URL, and for each expose a promise that resolves
  // when the first WPT run for that URL has begun.

  /** @type {Task[]} */
  const tasks = [];

  const numWptRequests = urlsToRun.length * SAMPLES;
  log.progress(`About to make ${numWptRequests} WPT requests. You have 10 seconds to cancel.`);
  await new Promise(resolve => setTimeout(resolve, 1000 * 10));

  // Start all the WPT requests.
  for (const url of urlsToRun) {
    tasks.push(createTask(url));
  }

  log.progress('waiting for first WPT run to start');

  // This is a work queue that handles collecting the local, unthrottled runs. It only operates
  // on one URL at a time.
  while (tasks.length) {
    // Wait for the next `wptStartedPromise` to resolve. Get the index so this task can be removed.
    const curIndex = await Promise.race(tasks.map((t, i) => t.wptStartedPromise.then(() => i)));
    const task = tasks[curIndex];
    const url = task.url;
    // The first WPT request for this URL has started.

    updateProgress(tasks, task);

    // Must run in series.
    for (let i = 0; i < SAMPLES; i++) {
      const resultPromise = repeatUntilPass(() => runUnthrottledLocally(url));
      task.unthrottledResults.push(await resultPromise);
      updateProgress(tasks, task);
    }

    // All the desktop runs are done now, so once WPT is finished too we can commit the data.
    // We can work on the next unthrottled task now, so do this part async.
    Promise.all(task.wptResultPromises).then(() => commit(summary, task));

    // Remove this tasks from the work queue.
    tasks.splice(curIndex, 1);
  }

  // Sanity check.
  for (const result of summary) {
    if (result.wpt.length !== SAMPLES || result.unthrottled.length !== SAMPLES) {
      throw new Error(`unexpected number of results for ${result.url}`);
    }
  }

  log.progress('archiving ...');
  await common.archive(common.collectFolder);
  log.log('done!');
  log.closeProgress();
}

main();
