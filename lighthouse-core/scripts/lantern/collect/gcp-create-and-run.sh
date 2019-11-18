#!/bin/bash

# This script is assumed to be run from the LH_ROOT directory.

gcloud compute instances create lantern-collect-instance \
  --image-family=ubuntu-1804-lts --image-project=ubuntu-os-cloud \
  --zone=us-central1-a \
  --boot-disk-size=100GB \
  --machine-type=n1-standard-2

echo "export WPT_KEY=\"$WPT_KEY\"" > .tmp_wpt_key
gcloud compute scp ./.tmp_wpt_key lantern-collect-instance:/tmp/wpt-key
rm .tmp_wpt_key

gcloud compute scp ./lighthouse-core/scripts/lantern/collect/gcp-setup.sh lantern-collect-instance:/tmp/gcp-setup.sh
gcloud compute scp ./lighthouse-core/scripts/lantern/collect/gcp-run.sh lantern-collect-instance:/tmp/gcp-run.sh
gcloud compute ssh lantern-collect-instance --command="bash /tmp/gcp-setup.sh"
gcloud compute ssh lantern-collect-instance --command="sudo -u lighthouse sh -c 'nohup /home/lighthouse/gcp-run.sh > /home/lighthouse/collect.log 2>&1 < /dev/null &'"

echo "Collection has started."
echo "Check-in on progress anytime by running..."
echo "  $ gcloud compute ssh lantern-collect-instance"
echo "  $ sudo -u lighthouse tail -f /home/lighthouse/collect.log"


echo "When complete run..."
echo "  $ gcloud compute scp lantern-collect-instance:/home/lighthouse/src/lighthouse/dist/collect-lantern-traces.zip ./collect-lantern-traces.zip"
echo "  $ gcloud compute instances delete lantern-collect-instance"
