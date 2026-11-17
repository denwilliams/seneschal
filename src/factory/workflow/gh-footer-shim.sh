#!/bin/sh
# harness-managed: gh-footer-shim v1
#
# The harness installs this as `gh` in the operator's global bin, so it comes before the system's `gh` on the PATH of every shell,
# container and exec tool a factory channel's agent has. It is plain POSIX sh so it runs in any sandbox image that has a shell.
#
# What it does. The agent and the harness post to GitHub through one account's token, so the only way a reader can tell the
# agent's text from the person's is a footer. When HARNESS_AGENT_FOOTER is set, this puts the footer on everything `gh` is asked
# to write as text: comments, reviews, issue and pull request descriptions, and the same writes through `gh api`. A body that
# already ends with the footer is left as it is. With no footer set it runs the real `gh` unchanged.
#
# What it refuses. A write whose text it cannot see (an editor, --fill, a template, `gh api --input`, a GraphQL mutation) is not
# passed on without a footer: it stops and says what to do instead. That is deliberate. See docs/FACTORY_WORKFLOW_DESIGN.md.
#
# It is not a security boundary: running the real `gh` by its full path skips it. It stops an agent that forgets, not one that tries.

nl='
'
cr=$(printf '\r')

die() {
  printf 'gh (harness footer guard): %s\n' "$*" >&2
  exit 1
}

# The real gh: the first one on the PATH that is not this file's own directory.
here=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P) || here=
real=
oldifs=$IFS
IFS=:
set -f
for dir in $PATH; do
  [ -n "$dir" ] || continue
  d=$(cd "$dir" 2>/dev/null && pwd -P) || continue
  [ "$d" = "$here" ] && continue
  if [ -x "$d/gh" ] && [ ! -d "$d/gh" ]; then
    real=$d/gh
    break
  fi
done
IFS=$oldifs
set +f
if [ -z "$real" ]; then
  printf 'gh: command not found\n' >&2
  exit 127
fi

footer=${HARNESS_AGENT_FOOTER-}
marker=${HARNESS_AGENT_FOOTER_MARKER-}
if [ -z "$footer" ] || [ -z "$marker" ]; then
  exec "$real" "$@"
fi

# stamp TEXT: sets `stamped` to the text with the footer after it, unless the text already ends with the footer's marker line.
stamp() {
  _t=$1
  while :; do
    case $_t in
      *[[:space:]]) _t=${_t%?} ;;
      *) break ;;
    esac
  done
  case $_t in
    *"$nl"*) _last=${_t##*"$nl"} ;;
    *) _last=$_t ;;
  esac
  _last=${_last%"$cr"}
  if [ "$_last" = "$marker" ]; then
    stamped=$_t
  elif [ -z "$_t" ]; then
    stamped=$footer
  else
    stamped=$_t$nl$nl$footer
  fi
}

# read_source PATH: sets `body` to the file's text, or to standard input's when PATH is `-`.
read_source() {
  if [ "$1" = - ]; then
    body=$(cat) || die "could not read the text from standard input"
  else
    body=$(cat "$1") || die "could not read $1"
  fi
}

# Which command: the first two words that are not flags (`gh issue comment ...`), looking past `-R owner/repo`.
cmd1=
cmd2=
skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then
    skip=0
    continue
  fi
  case $a in
    -R | --repo) skip=1 ;;
    -*) ;;
    *)
      if [ -z "$cmd1" ]; then
        cmd1=$a
      else
        cmd2=$a
        break
      fi
      ;;
  esac
done

case $cmd1:$cmd2 in
  issue:comment | pr:comment | issue:create | pr:create | issue:new | pr:new | issue:edit | pr:edit | pr:review | pr:revert) kind=body ;;
  issue:close | issue:reopen | pr:close | pr:reopen) kind=comment ;;
  api:*) kind=api ;;
  *) exec "$real" "$@" ;;
esac

# --- gh issue|pr comment, create, edit, review, revert: the text is --body, -b, --body-file or -F ------------------------------
if [ "$kind" = body ]; then
  sub=$cmd2
  have=0
  fills=0
  other=0
  web=0
  approve=0
  n=$#
  i=0
  while [ "$i" -lt "$n" ]; do
    a=$1
    shift
    i=$((i + 1))
    case $a in
      --)
        set -- "$@" "$a"
        while [ "$i" -lt "$n" ]; do
          set -- "$@" "$1"
          shift
          i=$((i + 1))
        done
        ;;
      --body | -b | --body-file | -F)
        [ "$i" -lt "$n" ] || die "$a needs a value"
        v=$1
        shift
        i=$((i + 1))
        case $a in
          --body | -b) stamp "$v" ;;
          *)
            read_source "$v"
            stamp "$body"
            ;;
        esac
        set -- "$@" --body "$stamped"
        have=1
        ;;
      --body=*)
        stamp "${a#--body=}"
        set -- "$@" --body "$stamped"
        have=1
        ;;
      --body-file=*)
        read_source "${a#--body-file=}"
        stamp "$body"
        set -- "$@" --body "$stamped"
        have=1
        ;;
      -b?*)
        v=${a#-b}
        stamp "${v#=}"
        set -- "$@" --body "$stamped"
        have=1
        ;;
      -F?*)
        v=${a#-F}
        read_source "${v#=}"
        stamp "$body"
        set -- "$@" --body "$stamped"
        have=1
        ;;
      -e | --editor)
        die "an editor cannot be used here, so the footer could not be added. Give the text with --body or --body-file."
        ;;
      --fill | --fill-first | --fill-verbose | -f)
        fills=1
        set -- "$@" "$a"
        ;;
      --template | -T | --recover)
        other=1
        if [ "$i" -lt "$n" ]; then
          set -- "$@" "$a" "$1"
          shift
          i=$((i + 1))
        else
          set -- "$@" "$a"
        fi
        ;;
      --web | -w)
        web=1
        set -- "$@" "$a"
        ;;
      --title | -t | --base | -B | --head | -H | --repo | -R | --milestone | -m | --label | -l | --project | -p | --assignee | --reviewer | \
        --add-assignee | --add-label | --add-project | --add-reviewer | --remove-assignee | --remove-label | --remove-project | --remove-reviewer)
        if [ "$i" -lt "$n" ]; then
          set -- "$@" "$a" "$1"
          shift
          i=$((i + 1))
        else
          set -- "$@" "$a"
        fi
        ;;
      -a | --approve | -r)
        # Booleans on `gh pr review` (--approve, --request-changes), values elsewhere (--assignee, --reviewer).
        if [ "$sub" = review ]; then
          [ "$a" = -r ] || approve=1
        fi
        if [ "$sub" != review ] && [ "$a" != --approve ] && [ "$i" -lt "$n" ]; then
          set -- "$@" "$a" "$1"
          shift
          i=$((i + 1))
        else
          set -- "$@" "$a"
        fi
        ;;
      *) set -- "$@" "$a" ;;
    esac
  done
  if [ "$have" = 0 ] && [ "$web" = 0 ]; then
    case $sub in
      create | new | revert)
        if [ "$fills" = 1 ]; then
          die "the text would be taken from the commits, so the footer could not be added. Give the description with --body or --body-file."
        fi
        if [ "$other" = 1 ]; then
          die "the text would come from a template or a saved draft, so the footer could not be added. Give the description with --body or --body-file."
        fi
        ;;
      review)
        # An approval with no words is still a review written as the account: give it a body that says who wrote it.
        if [ "$approve" = 1 ]; then set -- "$@" --body "$footer"; fi
        ;;
    esac
  fi
  exec "$real" "$@"
fi

# --- gh issue|pr close, reopen: the text is --comment or -c -----------------------------------------------------------------
if [ "$kind" = comment ]; then
  n=$#
  i=0
  while [ "$i" -lt "$n" ]; do
    a=$1
    shift
    i=$((i + 1))
    case $a in
      --)
        set -- "$@" "$a"
        while [ "$i" -lt "$n" ]; do
          set -- "$@" "$1"
          shift
          i=$((i + 1))
        done
        ;;
      --comment | -c)
        [ "$i" -lt "$n" ] || die "$a needs a value"
        v=$1
        shift
        i=$((i + 1))
        stamp "$v"
        set -- "$@" --comment "$stamped"
        ;;
      --comment=*)
        stamp "${a#--comment=}"
        set -- "$@" --comment "$stamped"
        ;;
      -c?*)
        v=${a#-c}
        stamp "${v#=}"
        set -- "$@" --comment "$stamped"
        ;;
      --reason | -r | --repo | -R)
        if [ "$i" -lt "$n" ]; then
          set -- "$@" "$a" "$1"
          shift
          i=$((i + 1))
        else
          set -- "$@" "$a"
        fi
        ;;
      *) set -- "$@" "$a" ;;
    esac
  done
  exec "$real" "$@"
fi

# --- gh api: a write whose body is a field named `body` ---------------------------------------------------------------------
# First look, without changing anything: the method, the endpoint, whether there are fields, whether the body is `--input`.
method=
endpoint=
fieldn=0
input=0
seen=0
skip=
for a in "$@"; do
  if [ -n "$skip" ]; then
    case $skip in
      method) method=$a ;;
      field) fieldn=$((fieldn + 1)) ;;
    esac
    skip=
    continue
  fi
  case $a in
    -X | --method) skip=method ;;
    --method=*) method=${a#--method=} ;;
    -X?*) method=${a#-X} ;;
    -f | --raw-field | -F | --field) skip=field ;;
    --raw-field=* | --field=* | -f?* | -F?*) fieldn=$((fieldn + 1)) ;;
    --input) input=1; skip=other ;;
    --input=*) input=1 ;;
    -H | --header | --jq | -q | -t | --template | --cache | --hostname | -p | --preview) skip=other ;;
    -*) ;;
    *)
      # The first word is `api` itself; the next is the endpoint.
      if [ "$seen" = 0 ]; then seen=1; elif [ -z "$endpoint" ]; then endpoint=$a; fi
      ;;
  esac
done
if [ -z "$method" ]; then
  if [ "$fieldn" -gt 0 ] || [ "$input" = 1 ]; then method=POST; else method=GET; fi
fi
method=$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')
case $method in
  POST | PATCH | PUT) ;;
  *) exec "$real" "$@" ;;
esac

ep=${endpoint#/}
ep=${ep%%\?*}
s1=
s2=
s3=
s4=
s5=
s6=
s7=
s8=
IFS=/ read -r s1 s2 s3 s4 s5 s6 s7 s8 <<EOF
$ep
EOF

# GraphQL carries its text inside a query string: a mutation could write anything, so it is refused. Reading is unaffected.
if [ "$s1" = graphql ]; then
  scan=
  skip=
  for a in "$@"; do
    if [ -n "$skip" ]; then
      case $skip in
        raw) scan=$scan$nl$a ;;
        typed)
          case $a in
            *=@-) die "a GraphQL request read from standard input could not be checked for writes. Use -f query=... instead." ;;
            *=@*) scan=$scan$nl$(cat "${a#*=@}" 2>/dev/null) ;;
            *) scan=$scan$nl$a ;;
          esac
          ;;
      esac
      skip=
      continue
    fi
    case $a in
      -f | --raw-field) skip=raw ;;
      -F | --field) skip=typed ;;
      --input | --input=*) die "a GraphQL request sent with --input could not be checked for writes. Use -f query=... instead." ;;
    esac
  done
  case $scan in
    *[Mm][Uu][Tt][Aa][Tt][Ii][Oo][Nn]*)
      die "a GraphQL mutation could post text without the footer. Use gh issue comment, gh pr comment, gh pr review or the REST endpoints with -f body=... instead."
      ;;
  esac
  exec "$real" "$@"
fi

# Which writes are a comment or a description, for adding a body when there is none.
needbody=0
if [ "$s1" = repos ] && [ "$method" = POST ]; then
  case $s4 in
    issues)
      if [ -z "$s5" ]; then needbody=1; fi
      if [ "$s6" = comments ] && [ -z "$s7" ]; then needbody=1; fi
      ;;
    pulls)
      if [ -z "$s5" ]; then needbody=1; fi
      if { [ "$s6" = reviews ] || [ "$s6" = comments ]; } && [ -z "$s7" ]; then needbody=1; fi
      if [ "$s6" = reviews ] && [ "$s8" = events ]; then needbody=1; fi
      ;;
    commits)
      if [ "$s6" = comments ] && [ -z "$s7" ]; then needbody=1; fi
      ;;
  esac
fi
if [ "$input" = 1 ] && [ "$s1" = repos ]; then
  case $s4 in
    issues | pulls | commits) die "a request body sent with --input could not be given the footer. Use -f body=... (and -f for the other fields) instead." ;;
  esac
fi

# Now rewrite: a field named exactly `body` is stamped, whichever way it is given, and sent as a plain string.
have=0
n=$#
i=0
while [ "$i" -lt "$n" ]; do
  a=$1
  shift
  i=$((i + 1))
  case $a in
    --)
      set -- "$@" "$a"
      while [ "$i" -lt "$n" ]; do
        set -- "$@" "$1"
        shift
        i=$((i + 1))
      done
      continue
      ;;
    -f | --raw-field | -F | --field)
      if [ "$i" -ge "$n" ]; then
        set -- "$@" "$a"
        continue
      fi
      v=$1
      shift
      i=$((i + 1))
      f=$a
      ;;
    --raw-field=*) f=--raw-field; v=${a#--raw-field=} ;;
    --field=*) f=--field; v=${a#--field=} ;;
    -f?*) f=-f; v=${a#-f}; v=${v#=} ;;
    -F?*) f=-F; v=${a#-F}; v=${v#=} ;;
    -X | --method | -H | --header | --jq | -q | -t | --template | --cache | --hostname | -p | --preview | --input)
      if [ "$i" -lt "$n" ]; then
        set -- "$@" "$a" "$1"
        shift
        i=$((i + 1))
      else
        set -- "$@" "$a"
      fi
      continue
      ;;
    *)
      set -- "$@" "$a"
      continue
      ;;
  esac
  case $v in
    body=*)
      text=${v#body=}
      case $f in
        -F | --field)
          case $text in
            @*)
              read_source "${text#@}"
              text=$body
              ;;
          esac
          ;;
      esac
      stamp "$text"
      set -- "$@" -f "body=$stamped"
      have=1
      ;;
    *) set -- "$@" "$f" "$v" ;;
  esac
done
if [ "$have" = 0 ] && [ "$needbody" = 1 ]; then
  set -- "$@" -f "body=$footer"
fi
exec "$real" "$@"
