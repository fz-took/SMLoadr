#!/bin/bash

# Build script


silent() { "$@" >/dev/null 2>&1; }

# Usage
usage="usage: $0 [options] [targets]
    target  - Any valid pkg target(s) (default is macos-x64,win{-x86,-x64},linux{-x86,-x64})
              Can be either space- or comma- seperated ('macos-x64 win-x86,linux' is valid)

    -n --no-update - Don't install/update node modules
    -h --help      - Show this help"

# Arg parsing
for arg in "$@"; do
	case "$arg" in
		-h|--help)
			echo "$usage"
			exit 1
		;;
		-n|--no-update)
			NO_UPDATE_NM=true
		;;
		*)
			if [[ -z "$targets" ]]; then
				targets="$arg"
			else
				targets+=",$arg"
			fi
		;;
	esac
done

# Update node modules
if [[ -z "$NO_UPDATE_NM" ]] && ! silent type npm; then
	echo "ERROR: npm not found."
	exit 1
fi
if [[ -z "$NO_UPDATE_NM" ]]; then
	npm install
fi

# Ensure needed files are available
if [[ -e "./node_modules/.bin/pkg" ]]; then
	PKG_CMD="./node_modules/.bin/pkg"
elif silent type pkg; then
	PKG_CMD="pkg"
else
	echo "ERROR: script couldn't find pkg!"
	exit 1
fi
if ! [[ -e package.json ]]; then
	echo -e "Wow. You are incredible.\nYou managed end up missing package.json in the current directory.\nGo home, you're drunk."
	exit 1
fi



# If targets list is empty, use defaults
if [[ -z "$targets" ]]; then
	targets="node9-macos-x64,node9-win-x64,node9-win-x86,node9-linux-x64,node9-linux-x86"
fi

# Package away
exec "$PKG_CMD" --out-dir "BUILD/" -t "$targets" package.json
