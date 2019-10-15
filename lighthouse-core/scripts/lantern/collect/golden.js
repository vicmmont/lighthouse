/**
 * @license Copyright 2019 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/** @typedef {import('./common.js').Result} Result */
/** @typedef {import('./common.js').Summary} Summary */
/** @typedef {import('../run-on-all-assets.js').Golden} Golden */

const fs = require('fs');
const rimraf = require('rimraf');
const common = require('./common.js');

/**
 * @param {LH.Result} lhr
 * @return {import('../../../audits/metrics.js').UberMetricsItem}
 */
function getMetrics(lhr) {
  const metricsDetails = /** @type {LH.Audit.Details.DebugData=} */ (
    lhr.audits['metrics'].details);
  /** @type {import('../../../audits/metrics.js').UberMetricsItem} */
  return metricsDetails && metricsDetails.items && metricsDetails.items[0];
}

/**
 * @template T
 * @param {T[]} values
 * @param {(sortValue: T) => number} mapper
 */
function getMedianBy(values, mapper) {
  const resultsWithValue = values.map(value => {
    return {sortValue: mapper(value), value};
  });

  resultsWithValue.sort((a, b) => a.sortValue - b.sortValue);

  if (resultsWithValue.length % 2 === 1) {
    return resultsWithValue[Math.floor(resultsWithValue.length / 2)].value;
  }

  // Select the value that is closest to the mean.
  const sum = resultsWithValue.reduce((acc, cur) => acc + cur.sortValue, 0);
  const mean = sum / resultsWithValue.length;
  const a = resultsWithValue[Math.floor(resultsWithValue.length / 2)];
  const b = resultsWithValue[Math.floor(resultsWithValue.length / 2) + 1];
  const comparison = Math.abs(a.sortValue - mean) < Math.abs(b.sortValue - mean);
  return comparison ? a.value : b.value;
}

/**
 * Returns run w/ the median TTI.
 * @param {string} url
 * @param {Result[]} results
 */
function getMedianResult(url, results) {
  // Runs can be missing metrics.
  const resultsWithMetrics = results.map(result => {
    const metrics = getMetrics(loadLhr(result.lhr));
    return {result, metrics};
  }).filter(({metrics}) => {
    return metrics && metrics.interactive;
  });

  const n = resultsWithMetrics.length;
  if (n <= 4) {
    log.log(`Not enough data for ${url} (only found ${n}). Consider re-running.`);
    return null;
  }

  return getMedianBy(resultsWithMetrics, ({metrics}) => Number(metrics.interactive)).result;
}

/**
 * @param {string} filename
 * @return {LH.Result}
 */
function loadLhr(filename) {
  return JSON.parse(fs.readFileSync(`${common.collectFolder}/${filename}`, 'utf-8'));
}

/**
 * @param {string} filename
 */
function copyToGolden(filename) {
  fs.copyFileSync(`${common.collectFolder}/${filename}`, `${common.goldenFolder}/${filename}`);
}

/**
 * @param {string} filename
 * @param {string} data
 */
function saveGoldenData(filename, data) {
  fs.writeFileSync(`${common.goldenFolder}/${filename}`, data);
}

/** @type {typeof common.ProgressLogger['prototype']} */
let log;

async function main() {
  log = new common.ProgressLogger();

  /** @type {Summary[]} */
  const summary = common.loadSummary();

  const goldenSites = [];
  for (const [index, {url, wpt, unthrottled}] of Object.entries(summary)) {
    log.progress(`finding median ${Number(index) + 1} / ${summary.length}`);
    const medianWpt = getMedianResult(url, wpt);
    const medianUnthrottled = getMedianResult(url, unthrottled);
    if (!medianWpt || !medianUnthrottled) continue;
    if (!medianUnthrottled.devtoolsLog) throw new Error(`missing devtoolsLog for ${url}`);

    const wptMetrics = getMetrics(loadLhr(medianWpt.lhr));
    goldenSites.push({
      url,
      wpt3g: {
        firstContentfulPaint: wptMetrics.firstContentfulPaint,
        firstMeaningfulPaint: wptMetrics.firstMeaningfulPaint,
        timeToFirstInteractive: wptMetrics.firstCPUIdle,
        timeToConsistentlyInteractive: wptMetrics.interactive,
        speedIndex: wptMetrics.speedIndex,
        largestContentfulPaint: wptMetrics.largestContentfulPaint,
      },
      unthrottled: {
        tracePath: medianUnthrottled.trace,
        devtoolsLogPath: medianUnthrottled.devtoolsLog,
      },
    });
  }
  /** @type {Golden} */
  const golden = {sites: goldenSites};

  rimraf.sync(common.goldenFolder);
  fs.mkdirSync(common.goldenFolder);
  saveGoldenData('site-index-plus-golden-expectations.json', JSON.stringify(golden, null, 2));
  for (const result of goldenSites) {
    log.progress('making site-index-plus-golden-expectations.json');
    copyToGolden(result.unthrottled.devtoolsLogPath);
    copyToGolden(result.unthrottled.tracePath);
  }

  log.progress('archiving ...');
  await common.archive(common.goldenFolder);
  log.closeProgress();
}

main();
