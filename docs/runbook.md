# AI platform lab runbook

## Purpose and current scope

A beginner lab for serving a demo sentiment model through a TypeScript gateway on AWS.
Local Compose, tests, image publication, GitHub OIDC authentication, manual ECS deployment,
and timed shutdown have been exercised successfully. Live health and prediction requests were verified.
The model is a small demonstration; its confidence is not a calibrated business metric.

Automated deployment failure cleanup has local tests. A live failing-deployment/circuit-breaker
exercise has not yet been performed. The stopped-service rollback workflow is a separate
configuration recovery exercise, not proof of recovery from a live outage.

## Resources

| Resource | Value |
| --- | --- |
| Region | ap-south-1 (Mumbai) |
| ECS cluster | ai-platform-lab |
| ECS service | ai-platform-lab-service-s7r5cujf |
| Task family | ai-platform-lab |
| Task size | 512 CPU units / 1024 MiB; Linux X86_64 |
| Gateway | TCP 3000 |
| Inference | TCP 8000, internal to the shared task |
| CloudWatch log group | /ecs/ai-platform-lab |
| Security group | sg-05f4fcf8629f78f9d |
| Shutdown role | ai-platform-lab-shutdown |
| Shutdown dead-letter queue | ai-platform-lab-shutdown-dlq |
| CLI profile | ai-platform-lab |

The two ECS containers share a task network namespace. Gateway uses
http://127.0.0.1:8000 to reach inference. In local Compose it uses http://inference:8000.

## Local development

From the repository root:

~~~powershell
docker compose up --build --detach --wait
docker compose ps
Invoke-RestMethod http://localhost:3000/health
$body = @{ text = "This product is amazing" } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:3000/api/analyze -Method Post -ContentType "application/json" -Body $body
docker compose logs --tail 100
docker compose down
~~~

## Publish an image pair

1. Merge reviewed changes to main and verify CI passes.
2. Actions → Publish images → Run workflow → main.
3. Tests and container integration must succeed before the workflow requests AWS credentials.
4. Save both image addresses and digests from the run Summary.

Tags contain the source commit, workflow run ID, and attempt number.
ECR repositories have immutable tags. Publication stores images; it does not deploy ECS.

## Deploy a short learning session

1. Verify desired, running, and pending task counts are all zero.
2. In the security group's inbound rules, set TCP 3000 to your current public IPv4 /32.
   Console “My IP” does this. Update it after changing Wi-Fi or VPN.
3. Actions → Deploy lab for 15 minutes → main. Supply the exact shared tag from Publish images.
4. The workflow verifies ECR digests, creates a task revision, creates and reads back a shutdown
   schedule, then starts one task. It waits up to five minutes for healthy containers.
5. From the healthy task in ECS, copy its current public IP. Public IPs can change every session.

~~~powershell
$gatewayUrl = "http://<CURRENT-PUBLIC-IP>:3000"
Invoke-RestMethod "$gatewayUrl/health"
$body = @{ text = "This product is amazing" } | ConvertTo-Json
Invoke-RestMethod -Uri "$gatewayUrl/api/analyze" -Method Post -ContentType "application/json" -Body $body
~~~

Expected prediction: positive, confidence approximately 0.54094, modelVersion sentiment-demo-v1.
The health endpoint checks gateway liveness; the prediction request exercises inference too.

## Confirm shutdown

The schedule requests desiredCount zero approximately 15 minutes after its creation.
The deployment Summary shows the scheduled UTC time (add 5 hours 30 minutes for IST).
Scheduler delivery and ECS stopping are asynchronous; 15 minutes is not an exact runtime cap.

~~~powershell
aws ecs describe-services --cluster ai-platform-lab --services ai-platform-lab-service-s7r5cujf --region ap-south-1 --profile ai-platform-lab --query "services[0].{desired:desiredCount,running:runningCount,pending:pendingCount}" --output json
~~~

Confirm all three counts are zero and the task's last status is Stopped.
Deprovisioning is cleanup before Stopped. An ACTIVE service or cluster does not mean a task is running.
Stopped task rows are history, not extra running tasks.

## Emergency stop

Set the service desired count to zero; stopping an individual task while desired count is one
allows the service to launch a replacement.

~~~powershell
aws ecs update-service --cluster ai-platform-lab --service ai-platform-lab-service-s7r5cujf --desired-count 0 --region ap-south-1 --profile ai-platform-lab --query "service.desiredCount"
~~~

Then run the status check above. Setting counts to zero does not delete images, logs, or other resources.
ECR storage and CloudWatch can still consume credits.

## Roll back the stopped service

1. Identify an earlier known-good revision from a deployment Summary's “Previous revision”.
2. Confirm the service has zero desired, running, and pending tasks.
3. Actions → Roll back stopped lab → main → enter the earlier revision number.
4. The workflow validates the task role/size and pinned project images, updates the service
   with desiredCount zero, and verifies the selected revision and zero counts.

This workflow does not start a task. Revisions containing the same image digests will produce
the same application behavior. Restoring a running application's earlier version requires a
separate live test and a fresh shutdown schedule.

## Troubleshooting

| Symptom | First check |
| --- | --- |
| Browser times out | Current task IP, explicit http:// and :3000, current My IP rule, task still running |
| Health works, prediction fails | Gateway logs and inference logs for the same request ID |
| 400 Invalid JSON | Send a serialized JSON body with application/json |
| 502 | Inference connection, upstream error, or unexpected response |
| 504 | Inference response exceeded gateway timeout |
| Old IP no longer responds | Use the new task's IP; stopped tasks lose their endpoint |
| Workflow says service must be stopped | Inspect service counts; do not bypass the guard |
| AssumeRoleWithWebIdentity denied | Deployer trust policy, exact main branch OIDC subject, provider/audience |
| AWS operation AccessDenied | Check the named operation against the scoped role; do not attach broad admin access |
| Shutdown did not occur | Manually set desired zero first; inspect Scheduler, DLQ, and CloudTrail UpdateService |

~~~powershell
aws logs tail /ecs/ai-platform-lab --since 30m --region ap-south-1 --profile ai-platform-lab
~~~

The shutdown target must use the complete actual service ARN ending in
service/ai-platform-lab/ai-platform-lab-service-s7r5cujf, not just the cluster name.
Schedules are retained after completion for inspection; remove old completed lab schedules
manually once their evidence is no longer needed.

## Budget and access

Keep the AWS Free Plan and previously configured budget alerts. Alerts and shutdown schedules
are controls to reduce spend, not guaranteed hard spending caps. Check credit balance regularly.
Avoid leaving tasks running between sessions. CI runs on GitHub runners; ECR publishing consumes
AWS storage. This lab has no load balancer or NAT gateway configured.

Use the scoped project profile for normal work. GitHub publisher and deployer roles use temporary
OIDC credentials. Neither workflow needs stored AWS access keys.

## Evidence and next work

Record the publish/deploy run URLs, source commit, image digests, task revision,
successful health/prediction response, and final zero counts.
Next MLOps work: held-out model evaluation, measurable quality checks, model artifact/version management,
and reliability testing beyond this deployment lab.
