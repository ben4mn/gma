#!/usr/bin/env bash
# Sends gma's sign-in codes and invites from Ben's Gmail (SMTP with an app
# password). Ben runs it on the server, so the password never leaves the box:
#
#   cd /home/ben/gma && bash deploy/use-gmail.sh [/path/to/another/project/.env]
#
# With a path, it reads that file (it never runs it) and looks for the Gmail
# address and the app password under the usual names: SMTP_USER / SMTP_PASS,
# GMAIL_ADDRESS / GMAIL_APP_PASSWORD, EMAIL_USER / EMAIL_PASS, MAIL_USERNAME /
# MAIL_PASSWORD, SENDER_EMAIL / SENDER_PASSWORD and the like, in any case. It
# prints which names it used, never the password. Whatever it doesn't find, it
# asks for (the password without echoing it). Then it:
#   1. checks the gma image can send through SMTP (if not: update it first),
#   2. copies .env to .env.bak-<date> (mode 0600),
#   3. sets SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS,
#      EMAIL_TRANSPORT=smtp and EMAIL_FROM in .env, keeping every other line
#      (mode 0600),
#   4. runs docker compose up -d (the app and the worker restart with the new
#      settings) and waits for the app to be healthy,
#   5. offers to send a test email.
#
# The password is never printed, never on a command line (anyone on the box
# can read those with ps) and never exported: bash builtins write it.
# Gmail sends about 500 emails a day from one account; gma needs a handful.
# Undo: cp .env.bak-<date> .env && docker compose up -d
#
# Don't remember which project has it? `bash deploy/use-gmail.sh --find`
# lists the .env files in your home that hold one (names only, no values).

set -euo pipefail
set +o xtrace # even under `bash -x`, nothing below is traced
umask 077

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="$ROOT/.env"
IMAGE=${GMA_IMAGE:-gma:local}
APP_CONTAINER=${GMA_APP_CONTAINER:-gma-app}
HEALTH_WAIT_S=${GMA_HEALTH_WAIT_S:-180}
USAGE='Usage: bash deploy/use-gmail.sh [/path/to/another/project/.env]'

# In order of preference: the first name with a value wins.
USER_KEYS=(SMTP_USER SMTP_USERNAME SMTP_EMAIL GMAIL_USER GMAIL_ADDRESS GMAIL_EMAIL GMAIL_ACCOUNT
  EMAIL_USER EMAIL_ADDRESS EMAIL_HOST_USER MAIL_USER MAIL_USERNAME SENDER_EMAIL)
PASS_KEYS=(SMTP_PASS SMTP_PASSWORD GMAIL_APP_PASSWORD GMAIL_PASS GMAIL_PASSWORD
  EMAIL_APP_PASSWORD EMAIL_PASS EMAIL_PASSWORD EMAIL_HOST_PASSWORD MAIL_PASS MAIL_PASSWORD SENDER_PASSWORD)

ADDRESS_RE='^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
APP_PASSWORD_RE='^[A-Za-z]{16}$'
PLAIN_VALUE_RE='^[A-Za-z0-9._@%+=:/,-]+$'

TMP_ENV=''
trap 'if [[ -n $TMP_ENV ]]; then rm -f "$TMP_ENV"; fi' EXIT

say() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die() {
  printf 'use-gmail: %s\n' "$*" >&2
  exit 1
}

# Names compare in any case.
same_name() {
  local result=1
  shopt -s nocasematch
  if [[ $1 == "$2" ]]; then result=0; fi
  shopt -u nocasematch
  return $result
}

# A .env value as the app would see it: no surrounding quotes, no trailing
# " # comment", no surrounding spaces. Sets UNQUOTED.
unquote() {
  local v=$1
  v=${v#"${v%%[![:space:]]*}"}
  case $v in
    \"*) v=${v#\"}; v=${v%%\"*} ;;
    \'*) v=${v#\'}; v=${v%%\'*} ;;
    *)
      v=${v%%[[:space:]]#*}
      v=${v%"${v##*[![:space:]]}"}
      ;;
  esac
  UNQUOTED=$v
}

# Reads file $1 line by line (never sourcing it) for the first of the names
# after it that has a value. Sets FOUND_KEY (as written there) and FOUND_VALUE.
find_key() {
  local file=$1 want line
  shift
  FOUND_KEY='' FOUND_VALUE=''
  for want in "$@"; do
    while IFS= read -r line || [[ -n $line ]]; do
      line=${line%$'\r'}
      [[ $line =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
      same_name "${BASH_REMATCH[2]}" "$want" || continue
      local key=${BASH_REMATCH[2]}
      unquote "${BASH_REMATCH[3]}"
      if [[ -n $UNQUOTED ]]; then
        FOUND_KEY=$key
        FOUND_VALUE=$UNQUOTED
        return 0
      fi
    done <"$file"
  done
  return 1
}

# Google shows an app password as "abcd efgh ijkl mnop"; Gmail wants the 16
# letters. Anything else is kept as it is. Sets PASSWORD.
normalize_password() {
  local p=$1 squeezed
  squeezed=${p//[[:space:]]/}
  if [[ $squeezed =~ $APP_PASSWORD_RE && $p =~ ^[A-Za-z[:space:]]+$ ]]; then p=$squeezed; fi
  PASSWORD=$p
}

# How a value is written into .env so docker compose reads it back unchanged:
# plain when it's only safe characters, else in single quotes (taken literally).
# Sets ENV_VALUE.
env_value() {
  if [[ $1 =~ $PLAIN_VALUE_RE ]]; then
    ENV_VALUE=$1
  else
    ENV_VALUE="'$1'"
  fi
}

# --find: lists the .env files under a folder (default: home, three levels
# down) that hold a password under one of the names above, with the names, so
# Ben can pick the older project to take it from. Prints no values.
find_candidates() {
  local dir=$1 file pass_key user_key count=0
  [[ -d $dir ]] || die "$dir isn't a folder."
  while IFS= read -r file; do
    [[ $file == "$ROOT"/* ]] && continue
    find_key "$file" "${PASS_KEYS[@]}" || continue
    pass_key=$FOUND_KEY
    user_key='no address'
    if find_key "$file" "${USER_KEYS[@]}"; then user_key=$FOUND_KEY; fi
    FOUND_VALUE=''
    say "$file  ($user_key, $pass_key)"
    count=$((count + 1))
  done < <(find "$dir" -maxdepth 3 -type f \( -name '.env' -o -name '.env.*' -o -name '*.env' \) \
    ! -name '*.example' ! -name '*.sample' ! -name '*.template' ! -name '.env.bak-*' \
    ! -path '*/node_modules/*' ! -path '*/.git/*' 2>/dev/null | sort)
  if ((count == 0)); then
    say "No .env under $dir has a password under the usual names."
  else
    say ""
    say "Then: bash deploy/use-gmail.sh <one of these files>"
  fi
}

# --- arguments and checks ------------------------------------------------------

SOURCE=''
case ${1:-} in
  -h | --help)
    say "$USAGE"
    say "       bash deploy/use-gmail.sh --find [folder]   lists the .env files that hold one (default: your home)"
    exit 0
    ;;
  --find)
    if (($# > 2)); then
      warn "$USAGE"
      exit 64
    fi
    find_candidates "${2:-$HOME}"
    exit 0
    ;;
esac
case $# in
  0) ;;
  1) SOURCE=$1 ;;
  *)
    warn "$USAGE"
    exit 64
    ;;
esac

if ((EUID == 0)); then
  die "run this as ben, not root: .env must stay readable by the user who runs docker compose."
fi
[[ -f $ENV_FILE ]] || die "there is no .env in $ROOT; make it first (README → Deploy, step 1)."
if [[ -n $SOURCE ]] && ! [[ -f $SOURCE && -r $SOURCE ]]; then
  die "can't read $SOURCE."
fi
command -v docker >/dev/null || die "docker isn't on PATH."
cd "$ROOT"

# The image must already know EMAIL_TRANSPORT=smtp, or the app would refuse
# to start with the new .env. No network, no volumes, no settings.
CHECK_JS="import('/app/server/src/config.js')"
CHECK_JS+=".then((m) => m.loadConfig({ NODE_ENV: 'test', EMAIL_TRANSPORT: 'smtp', SMTP_USER: 'check@example.com', SMTP_PASS: 'check' }, { warn() {} }))"
CHECK_JS+=".then(() => import('nodemailer')).then(() => process.exit(0), () => process.exit(3))"
docker image inspect "$IMAGE" >/dev/null 2>&1 ||
  die "docker can't find the image $IMAGE (or can't be used as $(id -un)). Build it first: cd $ROOT && docker compose up -d --build"
if ! docker run --rm --pull never --network none --entrypoint node "$IMAGE" -e "$CHECK_JS" >/dev/null 2>&1; then
  warn "The gma image ($IMAGE) can't send email through SMTP yet. Update it first:"
  warn "  cd $ROOT && git pull && docker compose up -d --build"
  warn "then run this again. Nothing was changed."
  exit 1
fi

# --- the Gmail address and the app password -----------------------------------

ADDRESS=''
PASSWORD=''
if [[ -n $SOURCE ]]; then
  if find_key "$SOURCE" "${USER_KEYS[@]}"; then
    if [[ $FOUND_VALUE =~ $ADDRESS_RE ]]; then
      ADDRESS=$FOUND_VALUE
      say "Gmail address: $ADDRESS (from $FOUND_KEY in $SOURCE)"
    else
      warn "$FOUND_KEY in $SOURCE isn't an email address, so I'll ask for it."
    fi
  else
    say "No Gmail address in $SOURCE (looked for ${USER_KEYS[*]})."
  fi
  if find_key "$SOURCE" "${PASS_KEYS[@]}"; then
    normalize_password "$FOUND_VALUE"
    say "App password: from $FOUND_KEY in $SOURCE (not shown)"
  else
    say "No password in $SOURCE (looked for ${PASS_KEYS[*]})."
  fi
  FOUND_VALUE=''
fi

if [[ -z $ADDRESS ]]; then
  read -r -p 'Gmail address: ' ADDRESS || true
  ADDRESS=${ADDRESS//[[:space:]]/}
  [[ $ADDRESS =~ $ADDRESS_RE ]] || die "that doesn't look like an email address. Nothing was changed."
fi
if [[ -z $PASSWORD ]]; then
  typed=''
  read -r -s -p "App password for $ADDRESS (16 letters, not shown): " typed || true
  printf '\n' >&2
  normalize_password "$typed"
  typed=''
  [[ -n $PASSWORD ]] || die "no password given. Nothing was changed."
fi

if [[ $PASSWORD == *"'"* ]]; then
  die "that password has a ' in it, which .env can't hold safely. Make a Gmail app password (https://myaccount.google.com/apppasswords) and use that. Nothing was changed."
fi
# In single quotes docker compose reads \' as an escaped quote, so a password
# ending in a backslash would run on into the lines after it.
if [[ $PASSWORD == *'\' ]]; then
  die "that password ends in a backslash, which .env can't hold safely. Make a Gmail app password (https://myaccount.google.com/apppasswords) and use that. Nothing was changed."
fi
if ! [[ $PASSWORD =~ $APP_PASSWORD_RE ]]; then
  warn "Note: that isn't shaped like a Gmail app password (16 letters). Gmail turns down an account's normal password;"
  warn "if the test email fails, make an app password at https://myaccount.google.com/apppasswords and run this again."
fi

# --- .env ------------------------------------------------------------------------

env_value "$PASSWORD"
NEW_KEYS=(SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASS EMAIL_TRANSPORT EMAIL_FROM)
NEW_VALUES=(smtp.gmail.com 465 true "$ADDRESS" "$ENV_VALUE" smtp "Grandma's family <$ADDRESS>")
ENV_VALUE=''

BACKUP=".env.bak-$(date +%Y%m%d-%H%M%S)"
cp "$ENV_FILE" "$ROOT/$BACKUP"
chmod 600 "$ROOT/$BACKUP"

# Each of the seven keys replaces its first line in .env (later copies go), the
# ones .env didn't have go at the end, and every other line stays as it was.
TMP_ENV=$(mktemp "$ROOT/.env.new.XXXXXX")
written=' '
{
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ ${line%$'\r'} =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*= ]]; then
      key=${BASH_REMATCH[2]}
      replaced=0
      for i in "${!NEW_KEYS[@]}"; do
        if [[ ${NEW_KEYS[$i]} == "$key" ]]; then
          if [[ $written != *" $key "* ]]; then
            printf '%s=%s\n' "$key" "${NEW_VALUES[$i]}"
            written="$written$key "
          fi
          replaced=1
          break
        fi
      done
      if ((replaced)); then continue; fi
    fi
    printf '%s\n' "$line"
  done <"$ENV_FILE"
  for i in "${!NEW_KEYS[@]}"; do
    if [[ $written != *" ${NEW_KEYS[$i]} "* ]]; then printf '%s=%s\n' "${NEW_KEYS[$i]}" "${NEW_VALUES[$i]}"; fi
  done
} >"$TMP_ENV"
chmod 600 "$TMP_ENV"
mv -f "$TMP_ENV" "$ENV_FILE"
TMP_ENV=''
NEW_VALUES=()
PASSWORD=''
say "Wrote the Gmail settings into $ENV_FILE (the old one is $BACKUP)."

UNDO="cp $BACKUP .env && docker compose up -d"

# --- restart and check -------------------------------------------------------------

say "Restarting gma with the new settings…"
if ! docker compose up -d; then
  warn "docker compose up -d failed. To go back: cd $ROOT && $UNDO"
  exit 1
fi

# The app's healthcheck runs every 30 s, so this takes up to a minute. A
# restart means it crashed at least once (a bad setting): stop waiting.
waited=0
while :; do
  state=$(docker inspect --format '{{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$APP_CONTAINER" 2>/dev/null || echo 'missing')
  restarts=${state%% *}
  status=${state#* }
  if [[ $restarts =~ ^[0-9]+$ ]] && ((restarts > 0)); then status=crashed; fi
  case $status in
    healthy) break ;;
    unhealthy | crashed | exited | dead)
      warn "The app isn't healthy ($status). Its log: docker compose logs --tail=30 app"
      warn "To go back: cd $ROOT && $UNDO"
      exit 1
      ;;
  esac
  if ((waited >= HEALTH_WAIT_S)); then
    warn "The app wasn't healthy after ${HEALTH_WAIT_S} s ($status). Its log: docker compose logs --tail=30 app"
    warn "To go back: cd $ROOT && $UNDO"
    exit 1
  fi
  sleep 3
  waited=$((waited + 3))
done
say "gma is up and sends email from $ADDRESS."

TEST_TO=''
read -r -p 'Send a test email to (an address, or Enter to skip): ' TEST_TO || true
TEST_TO=${TEST_TO//[[:space:]]/}
if [[ -z $TEST_TO ]]; then
  say "Skipped the test. Later: docker compose exec -T app npm run -s email:test -- --to you@example.com"
  exit 0
fi
[[ $TEST_TO =~ $ADDRESS_RE ]] || die "that doesn't look like an email address. Later: docker compose exec -T app npm run -s email:test -- --to you@example.com"
if docker compose exec -T app npm run -s email:test -- --to "$TEST_TO"; then
  say "Check $TEST_TO's inbox (and its spam folder)."
else
  warn "The test email didn't go out (above). Check the address and the app password, then run this again."
  warn "To go back: cd $ROOT && $UNDO"
  exit 1
fi
