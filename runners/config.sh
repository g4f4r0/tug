#!/usr/bin/env bash
# Changes Tug's settings in /etc/tug/tug.env, keeping every other line as it is, then restarts both services. Each line
# on stdin is NAME="value", which replaces every line that sets NAME, or -NAME, which removes them. With --list, it
# prints the names set, one per line. It never prints a value.
#
#   sudo config.sh < changes
#   sudo config.sh --list
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
file=/etc/tug/tug.env

if [[ ${1:-} == --list ]]; then
  [[ ! -e $file ]] || sed -n 's/^\(TUG_[A-Z_]*\)=.*/\1/p' "$file" | sort -u
  exit 0
fi

set_line='^(TUG_[A-Z_]+)=".*"$'
unset_line='^-(TUG_[A-Z_]+)$'
declare -A changed=()
adds=()
while IFS= read -r line || [[ -n $line ]]; do
  if [[ $line =~ $set_line ]]; then
    adds+=("$line")
  elif [[ ! $line =~ $unset_line ]]; then
    echo "Not a setting change: ${line%%=*}" >&2
    exit 1
  fi
  changed[${BASH_REMATCH[1]}]=1
done
((${#changed[@]})) || { echo "No setting changes on stdin." >&2; exit 1; }

umask 077
new=$(mktemp)
trap 'rm -f "$new"' EXIT
if [[ -e $file ]]; then
  while IFS= read -r line || [[ -n $line ]]; do
    name=${line%%=*}
    [[ -n $name && -n ${changed[$name]:-} ]] || printf '%s\n' "$line"
  done <"$file" >"$new"
fi
((${#adds[@]} == 0)) || printf '%s\n' "${adds[@]}" >>"$new"
install -d -m 0755 /etc/tug
install -m 0600 "$new" "$file"
systemctl restart tug-keys.service tug-runners.service
