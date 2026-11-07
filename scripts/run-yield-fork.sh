#!/usr/bin/env bash
cd "$(dirname "$0")/.."
NODE_NO_WARNINGS=1 nohup npx tsx agent/src/yield-agent.ts --mode fork --decide-minutes ${DECIDE_MINUTES:-60} --tick-seconds ${TICK_SECONDS:-60} >> data/yield-fork.log 2>&1 < /dev/null & disown
