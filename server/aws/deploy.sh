#!/usr/bin/env bash
# Put the 善款簿 backup server on AWS, or update it: the stack in template.yaml, then the code.
#
#   aws login                      # first, if your session has expired
#   bash server/aws/deploy.sh      # from anywhere in a copy of this repo
#
# Safe to run again: it keeps the bucket, the backups and the key, and updates the rest.
# Settings, all optional, are environment variables:
#   STACK_NAME      default dana-backup
#   AWS_REGION      default: the region in your AWS settings
#   DOMAIN_NAME, CERTIFICATE_ARN   the address the app calls and its ACM certificate (see README)
#   ALERT_EMAIL     gets an email when the month's AWS bill passes US$5
#   ALLOWED_ORIGINS default https://mum.franklee.asia
set -euo pipefail

STACK="${STACK_NAME:-dana-backup}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
REGION="${AWS_REGION:-$(aws configure get region || true)}"
[ -n "$REGION" ] || { echo "Stopped: no region. Set AWS_REGION, for example AWS_REGION=ap-southeast-1" >&2; exit 1; }
export AWS_REGION="$REGION" AWS_PAGER=""

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

aws sts get-caller-identity --query Account --output text >/dev/null || { echo "Stopped: not signed in to AWS. Run: aws login" >&2; exit 1; }

say "1/3 The stack ($STACK in $REGION)"
params=()
status="$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)"
case "$status" in
  ROLLBACK_COMPLETE|CREATE_FAILED|DELETE_FAILED)
    # A first try that failed leaves a stack that cannot be updated, and may leave its bucket behind.
    echo "Stopped: the stack $STACK is in state $status from an earlier failed try." >&2
    echo "See what went wrong:  aws cloudformation describe-stack-events --stack-name $STACK --max-items 15" >&2
    echo "Then delete it (aws cloudformation delete-stack --stack-name $STACK), and any empty dana-backup bucket it left, and run this again." >&2
    exit 1 ;;
esac
aws cloudformation validate-template --template-body "file://$HERE/template.yaml" >/dev/null
if [ -n "$status" ]; then
  echo "Updating the existing stack. The key for reading backups stays the same."
else
  # Made here and handed straight to CloudFormation; it is never written to a file.
  key="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')"
  params+=("BackupToken=$key")
  NEW_KEY=1
fi
[ -n "${DOMAIN_NAME:-}" ] && params+=("DomainName=$DOMAIN_NAME")
[ -n "${CERTIFICATE_ARN:-}" ] && params+=("CertificateArn=$CERTIFICATE_ARN")
[ -n "${ALERT_EMAIL:-}" ] && params+=("AlertEmail=$ALERT_EMAIL")
[ -n "${ALLOWED_ORIGINS:-}" ] && params+=("AllowedOrigins=$ALLOWED_ORIGINS")
aws cloudformation deploy --stack-name "$STACK" --template-file "$HERE/template.yaml" \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  ${params[@]+--parameter-overrides "${params[@]}"}

out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
FN="$(out FunctionName)"
URL="$(out ApiUrl)"

say "2/3 The code"
ZIP="$(mktemp -d)/backup.zip"
(cd "$ROOT" && zip -q -X "$ZIP" lib/model.js server/backup-core.js server/aws/lambda.js server/aws/store-s3.js)
aws lambda update-function-code --function-name "$FN" --zip-file "fileb://$ZIP" --query LastUpdateStatus --output text
aws lambda wait function-updated --function-name "$FN"
rm -f "$ZIP"

say "3/3 Check"
health="$(curl -fsS --retry 5 --retry-delay 2 "$URL/health" || true)"
echo "$URL/health -> ${health:-no answer}"
[ "$health" = '{"ok":true}' ] || { echo "Stopped: the server did not answer as expected." >&2; exit 1; }
# /health never touches the bucket, so also read from it. These two checks write nothing.
readkey="$(aws lambda get-function-configuration --function-name "$FN" --query Environment.Variables.BACKUP_TOKEN --output text)"
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
listed="$(code -H "Authorization: Bearer $readkey" "$URL/backups")"
missing="$(code -H "Authorization: Bearer $readkey" "$URL/backups/$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))')/latest")"
nokey="$(code "$URL/backups")"
unset readkey
echo "listing backups with the key -> $listed (want 200); a phone with no backup -> $missing (want 404); without the key -> $nokey (want 401)"
[ "$listed" = 200 ] && [ "$missing" = 404 ] && [ "$nokey" = 401 ] || { echo "Stopped: the server cannot read its bucket correctly. Logs: aws logs tail /aws/lambda/$FN --since 10m" >&2; exit 1; }

cat <<DONE

The backup server is running at:
  $URL
Backups are kept in the bucket: $(out BucketName)
DONE
if [ -n "${NEW_KEY:-}" ]; then
  cat <<DONE

The key for reading backups back (keep it in your password manager; it is shown only this once):
  $key
To see it again later:
  aws lambda get-function-configuration --function-name $FN --query Environment.Variables.BACKUP_TOKEN --output text
DONE
fi
target="$(out DomainTarget)"
[ -n "$target" ] && [ "$target" != "None" ] && echo && echo "Point ${DOMAIN_NAME:-the domain} at this with a CNAME record (DNS only): $target"
exit 0
