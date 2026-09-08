#!/usr/bin/env bash
#
# Find your PowerView home key in an iPhone backup.
#
# The PowerView app keeps the key in its own SQLite database. On iOS that
# database is only reachable through a local backup, and a backup stores every
# file under a hashed name - so neither the app nor the file can be found by
# looking for a likely name. This locates the database by its SCHEMA instead:
# the one carrying both a `homes` and a `gateways` table is the app's.
#
# The key is never written anywhere. It is printed once, for you to paste
# straight into the Homey app's settings.
#
# Requires: macOS with Finder-made backups, sqlite3 (ships with macOS).
#
# Usage:
#   ./scripts/find-homekey-ios.sh              # newest backup
#   ./scripts/find-homekey-ios.sh --list       # show backups and app domains
#   ./scripts/find-homekey-ios.sh <backup-dir> # a specific backup

set -euo pipefail

BACKUP_ROOT="${HOME}/Library/Application Support/MobileSync/Backup"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1" >&2; }
fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing '$1'. Install it and try again."
}

# --- pick a backup ------------------------------------------------------------

# macOS protects the backup folder with TCC: the folder itself is visible, but
# listing what is inside it needs Full Disk Access. A glob over an unreadable
# directory quietly expands to nothing, which is indistinguishable from the
# folder being empty - so without this check the script tells someone who just
# made a backup that they have none. Test the read for real rather than
# trusting `-r`, which reports on the file mode and not on TCC.
assert_backup_root_readable() {
  ls "$1" >/dev/null 2>&1 && return 0

  cat >&2 <<'DENIED'
macOS will not let this terminal read the backup folder.

The folder is there; its contents are protected. Grant the terminal Full Disk
Access, then run this again:

  System Settings -> Privacy & Security -> Full Disk Access
  Switch on Terminal (or iTerm, or whichever one you are using)
  Quit that app completely and reopen it - the change only takes effect on
  a fresh launch

This says nothing about whether a backup exists; it is only about permission.
DENIED
  exit 1
}

newest_backup() {
  local newest='' dir
  for dir in "$BACKUP_ROOT"/*/; do
    [ -f "${dir}Manifest.db" ] || continue
    if [ -z "$newest" ] || [ "${dir}Manifest.db" -nt "${newest}Manifest.db" ]; then
      newest="$dir"
    fi
  done
  [ -n "$newest" ] || return 1
  printf '%s' "${newest%/}"
}

device_name() {
  plutil -extract "Device Name" raw -o - "$1/Info.plist" 2>/dev/null || printf 'unknown device'
}

backup_date() {
  plutil -extract "Last Backup Date" raw -o - "$1/Info.plist" 2>/dev/null || printf 'unknown date'
}

assert_not_encrypted() {
  local encrypted
  encrypted=$(plutil -extract IsEncrypted raw -o - "$1/Manifest.plist" 2>/dev/null || printf 'false')
  [ "$encrypted" = "true" ] || return 0

  cat >&2 <<'ENCRYPTED'
This backup is encrypted, so its files cannot be read.

In Finder: select your iPhone, and under General untick
"Encrypt local backup". Finder will ask for the existing password. Then
back up again and re-run this.

An unencrypted backup leaves out Health data and saved passwords. It still
contains app data, which is all this needs.
ENCRYPTED
  exit 1
}

# --- find the database --------------------------------------------------------

# Backups store each file at <backup>/<first two chars of fileID>/<fileID>.
stored_path() {
  printf '%s/%s/%s' "$1" "${2:0:2}" "$2"
}

is_sqlite() {
  [ -f "$1" ] || return 1
  # Matched through a pipe rather than a command substitution: backup files are
  # binary, and capturing one that starts with a null byte makes the shell warn
  # about discarding it - noise that looks like a fault and is not.
  head -c 16 "$1" 2>/dev/null | LC_ALL=C grep -qa 'SQLite format 3'
}

# Table names in a database, one per line, lowercased.
table_names() {
  sqlite3 "$1" "SELECT name FROM sqlite_master WHERE type='table';" 2>/dev/null \
    | tr '[:upper:]' '[:lower:]'
}

# Name the table holding the home row, or fail if this is not the app's
# database. Two shapes are recognised: the plain `homes`/`gateways` pair the
# Android app uses, and Core Data's, which prefixes every entity with Z - so
# the same model appears as ZHOME and ZGATEWAY. iOS apps overwhelmingly use
# Core Data, and matching only the Android names is why a backup that plainly
# contained the app's data came back empty-handed.
powerview_home_table() {
  local tables
  tables=$(table_names "$1") || return 1

  if grep -qx homes <<<"$tables" && grep -qx gateways <<<"$tables"; then
    printf 'homes'
    return 0
  fi
  if grep -qx zhome <<<"$tables" && grep -qx zgateway <<<"$tables"; then
    printf 'ZHOME'
    return 0
  fi
  return 1
}

# File IDs to test, narrowest plausible set first. The app's own domain is the
# obvious place, but the bundle identifier is not documented anywhere and the
# Gen 3 app may not share Gen 2's - so a miss falls back to every app's data.
candidate_ids() {
  local manifest="$1/Manifest.db" ids
  ids=$(sqlite3 "$manifest" \
    "SELECT fileID FROM Files
      WHERE domain LIKE '%powerview%' OR domain LIKE '%hunterdouglas%';" 2>/dev/null || true)

  if [ -n "$ids" ]; then
    printf '%s\n' "$ids"
    return
  fi

  warn "No app domain mentioned PowerView; searching every app's data instead."
  sqlite3 "$manifest" \
    "SELECT fileID FROM Files WHERE domain LIKE 'AppDomain%';" 2>/dev/null || true
}

# Prints "<home table>|<path>". Both halves have to travel on stdout: the
# caller reads this through a command substitution, so a variable set here
# would be set in a subshell and lost.
find_database() {
  local backup="$1" id path table
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    path=$(stored_path "$backup" "$id")
    is_sqlite "$path" || continue
    table=$(powerview_home_table "$path") || continue
    printf '%s|%s' "$table" "$path"
    return 0
  done < <(candidate_ids "$backup")
  return 1
}

# Describe what the app actually stored, for when the search comes up empty.
# Structure only - paths, table names, column names - so it can be shared
# without handing over the key along with it.
probe() {
  local backup="$1" id domain rel path tables t cols
  bold "Files under the PowerView domains"

  while IFS='|' read -r id domain rel; do
    [ -n "$id" ] || continue
    path=$(stored_path "$backup" "$id")
    [ -f "$path" ] || continue

    if is_sqlite "$path"; then
      printf '  [sqlite] %s :: %s\n' "$domain" "$rel"
      tables=$(sqlite3 "$path" "SELECT name FROM sqlite_master WHERE type='table';" 2>/dev/null)
      while IFS= read -r t; do
        [ -n "$t" ] || continue
        printf '      table %s\n' "$t"
        # `|| true` is load-bearing: pipefail makes a grep that matches
        # nothing fail the whole pipeline, and set -e then ends the probe
        # right where it had the most to say.
        cols=$(sqlite3 "$path" "SELECT name FROM pragma_table_info('$t');" 2>/dev/null \
          | { grep -i key || true; } | tr '\n' ' ')
        [ -n "$cols" ] && printf '        key-ish columns: %s\n' "$cols"
      done <<< "$tables"
    else
      local size hex
      size=$(wc -c <"$path" | tr -d ' ')
      hex=$({ LC_ALL=C grep -oaE '[0-9a-fA-F]{32}' "$path" 2>/dev/null || true; } \
        | sort -u | wc -l | tr -d ' ')
      # An `[ ... ] && ...` that comes out false would end the whole probe
      # under `set -e`, which is exactly what it did: the listing stopped
      # after the first entry whose count was zero.
      printf '  %s :: %s (%s bytes' "$domain" "$rel" "$size"
      if [ "$hex" -gt 0 ]; then
        printf ', %s key-shaped strings' "$hex"
      fi
      printf ')\n'
    fi
  done < <(sqlite3 "$backup/Manifest.db" \
    "SELECT fileID || '|' || domain || '|' || relativePath FROM Files
      WHERE domain LIKE '%powerview%' OR domain LIKE '%hunterdouglas%';" 2>/dev/null)

  printf '\n'
  bold "Paste the above back and the search can be pointed at the right table."
}

# --- report -------------------------------------------------------------------

list_backups() {
  assert_backup_root_readable "$BACKUP_ROOT"
  bold "Backups in $BACKUP_ROOT"
  local dir
  for dir in "$BACKUP_ROOT"/*/; do
    [ -f "${dir}Manifest.db" ] || continue
    printf '  %s\n    %s, %s\n' "${dir%/}" "$(device_name "${dir%/}")" "$(backup_date "${dir%/}")"
  done

  local backup
  backup=$(newest_backup) || fail "No backups found."
  printf '\n'
  bold "App domains in the newest backup"
  sqlite3 "$backup/Manifest.db" \
    "SELECT DISTINCT domain FROM Files WHERE domain LIKE 'AppDomain%' ORDER BY domain;" \
    | sed 's/^/  /'
}

print_key() {
  local db="$1" table="$2" col val found=0
  bold "Found the PowerView database."
  printf '  %s\n  home table: %s\n\n' "$db" "$table"

  while IFS= read -r col; do
    [ -n "$col" ] || continue
    case "$(tr '[:upper:]' '[:lower:]' <<<"$col")" in
      *key*)
        val=$(sqlite3 "$db" "SELECT \"$col\" FROM \"$table\" LIMIT 1;" 2>/dev/null || true)
        [ -n "$val" ] || continue
        printf '\033[1;32m  %s = %s\033[0m\n' "$col" "$val"
        found=1
        ;;
    esac
  done < <(sqlite3 "$db" "SELECT name FROM pragma_table_info('$table');" 2>/dev/null || true)

  if [ "$found" -eq 0 ]; then
    warn "No column on '$table' had 'key' in its name. Its full schema:"
    sqlite3 "$db" ".schema $table" | sed 's/^/    /' >&2
    warn "Look for a 32-character hexadecimal value; that is the key."
    return 1
  fi

  cat <<'NEXT'

That 32-character value is your home key. One key covers every shade in the
home, so this is a one-time step.

Paste it into Homey: Settings -> Apps -> PowerView BLE.

Do not post it anywhere public: anyone within Bluetooth range who has it can
drive your shades.
NEXT
}

# --- main ---------------------------------------------------------------------

need sqlite3
need plutil

case "${1:-}" in
  --list|-l) list_backups; exit 0 ;;
  --probe|-p)
    [ -d "$BACKUP_ROOT" ] || fail "No backup folder at $BACKUP_ROOT."
    assert_backup_root_readable "$BACKUP_ROOT"
    probe "$(newest_backup)"; exit 0 ;;
  --help|-h) sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

if [ -n "${1:-}" ]; then
  backup="${1%/}"
  [ -f "$backup/Manifest.db" ] || fail "$backup is not a backup (no Manifest.db)."
else
  # Only the search needs the standard location; a backup named outright may
  # live anywhere, including a copy pulled off another disk.
  [ -d "$BACKUP_ROOT" ] || fail "No backup folder at $BACKUP_ROOT. Make a backup in Finder first."
  assert_backup_root_readable "$BACKUP_ROOT"
  backup=$(newest_backup) || fail "$(cat <<'NONE'
No backups found.

The folder is readable and empty of backups, so this is not a permissions
problem. Either no local backup has been made yet, or the phone is set to back
up to iCloud rather than to this Mac - in Finder, that is the "Back up all of
the data on your iPhone to this Mac" option.

A backup that is still running has no Manifest.db yet and will not be seen
until it finishes.
NONE
)"
fi

bold "Backup: $(device_name "$backup"), $(backup_date "$backup")"
printf '  %s\n\n' "$backup"

assert_not_encrypted "$backup"

printf 'Searching for the PowerView database...\n'
if found=$(find_database "$backup"); then
  printf '\n'
  print_key "${found#*|}" "${found%%|*}"
else
  warn "No database matched a known PowerView schema."
  warn "Showing what the app did store, so the search can be aimed properly."
  printf '\n' >&2
  probe "$backup"
  exit 1
fi
