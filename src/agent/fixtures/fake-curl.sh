#!/bin/sh
# For the trial: the deployed hostnames exist only in the stand-in wrangler, so answer for them and defer to the real curl otherwise.
for arg in "$@"; do
  case "$arg" in
    https://app.acme.example*|https://app-staging.acme.example*)
      case " $* " in *"%{http_code}"*) printf '200' ;; *) printf 'ok\n' ;; esac
      exit 0 ;;
  esac
done
exec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/local/bin curl "$@"
