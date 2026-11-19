# 善款簿 backup server on AWS

The same backup server as the one on the Raspberry Pi, running on AWS instead: phones send their records to an API Gateway address, a Lambda function checks them, and they are kept in a private S3 bucket. Nothing at home has to stay switched on.

**Status (19 Nov 2026): live. `https://mum-backup.franklee.asia` has pointed at this server since 19 Nov, so phones now back up to the S3 bucket.** The Pi's server is still installed and running but no longer receives anything; see step 6 below. The bucket also holds one made-up test backup, a fund named 部署测试 (deploy test), which stays because nothing there is ever deleted.

To go back to the Pi: in Cloudflare DNS, set the `mum-backup` record to CNAME `862f8cc9-f543-43f8-a43d-2882f38e560f.cfargotunnel.com`, Proxied.

## What gets created

`template.yaml` creates, in one CloudFormation stack (`dana-backup` by default):

- **An S3 bucket** for the backups. It is private, encrypted, keeps earlier copies of anything overwritten, and stays if the stack is deleted.
- **A Lambda function** that runs `server/backup-core.ts`, the same rules as on the Pi, built to JavaScript by the deploy script. Its role can read, write and list backups, and read and write shared books (`books/`), but cannot delete anything.
- **An API Gateway HTTP API** in front of the function, limited to 2 requests a second from everyone together.
- **A log group** kept for 90 days. Logs show the first 8 characters of a phone's id and how many records it sent, never the records.
- **Optionally, a budget alert** that emails you when the account's monthly bill passes US$5.

Differences from the Pi:

- There is no limit on uploads from one internet address, because a Lambda function keeps no memory between requests. The 2-requests-a-second limit and the 1 GB storage limit cap the cost instead.
- The key for reading backups is stored in the function's settings. Anyone who can sign in to the AWS account and view Lambda settings can see it.

At mum's usage the cost should be a few US cents a month. That is an estimate, not a measured bill.

## Deploy

```sh
npm install                                            # once: the deploy builds the server from TypeScript
aws login                                              # if your session has expired
ALERT_EMAIL=you@example.com bash server/aws/deploy.sh  # ALERT_EMAIL is optional
```

The first run prints the key for reading backups once. Keep it in your password manager. Running the script again updates the code and keeps the bucket, the backups and the key.

It ends by printing the server's own AWS address. Check it before changing anything else:

```sh
URL=https://xxxxxxxx.execute-api.ap-southeast-1.amazonaws.com   # as printed
KEY=...                                                          # as printed
curl "$URL/health"                                               # {"ok":true}
curl -H "Authorization: Bearer $KEY" "$URL/backups"              # the phones that have backed up
```

## Moving the app over from the Pi

The app sends backups to `https://mum-backup.franklee.asia`, which today leads to the Pi through a Cloudflare Tunnel. Moving to AWS means pointing that same address at AWS, so the app needs no change. Do the steps in order, and leave the Pi running until the last one.

1. Deploy as above, and check the AWS address answers.
2. Ask AWS for a certificate for the address, in the same region as the stack:
   ```sh
   aws acm request-certificate --domain-name mum-backup.franklee.asia --validation-method DNS
   aws acm describe-certificate --certificate-arn <arn from the line above> --query Certificate.DomainValidationOptions
   ```
   Add the CNAME record it shows in Cloudflare DNS (DNS only, not proxied) and wait until the certificate's status is `ISSUED`.
3. Deploy again with the address and certificate:
   ```sh
   DOMAIN_NAME=mum-backup.franklee.asia CERTIFICATE_ARN=<arn> bash server/aws/deploy.sh
   ```
   It prints where to point the address.
4. In Cloudflare DNS, replace the tunnel's record for `mum-backup` with a CNAME to that target, **DNS only** (grey cloud). From this moment phones back up to AWS.
5. Check `https://mum-backup.franklee.asia/health`, then change something in the app and confirm the phone appears in `/backups`.
6. Only then stop the Pi's server: `sudo systemctl disable --now dana-backup`. Keep `/var/lib/dana-backup` on the Pi; the backups already there are not copied to AWS.

To go back, point the Cloudflare record at the tunnel again and start the Pi's service.

## Restoring a phone

```sh
curl -H "Authorization: Bearer $KEY" "$URL/backups/<device>/latest" -o backup.json
```

Send `backup.json` to the phone, then in the app tap the version line in 设置 five times and choose 从备份文件恢复. Every earlier version is in the bucket under `devices/<device>/`.
