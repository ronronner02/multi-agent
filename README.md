# Multi-Agent

A team of coding agents, defined in YAML and run as one managed system. The engine
lives in `engine/`; it builds on OpenRig and adds owner-governed team runs.

## Quick start

Requires Linux or WSL2, with `git`, `tmux`, and Node.js 22 or 24.

```bash
git clone https://github.com/ronronner02/multi-agent.git && cd multi-agent
./setup.sh                                  # install, build, create the owner token
export PATH="$PWD/engine/node_modules/.bin:$PATH"
./scripts/start.sh                          # start the daemon in managed mode
rig tui                                     # open the dashboard
```

Agents run as your own user; no `sudo` and no system provisioning. Creating a team
task (`rig team start`) is coming next.