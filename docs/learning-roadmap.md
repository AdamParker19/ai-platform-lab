# Learning roadmap: ML engineering, AWS, and reliable backends

Updated: 2026-10-06. Owner: Anmol. Project: AdamParker19/ai-platform-lab.

## Goal and certification target

Build the understanding and practical evidence to prepare for AWS Certified Machine Learning Engineer – Associate, using the updated MLA-C02 exam guide. The English C02 exam is currently in beta; recheck the current exam version and registration details before booking. AWS's overview currently uses ME1-C02 in its beta registration table while the detailed guide uses MLA-C02.

The updated guide includes traditional ML, foundation models, generative AI, RAG, and agentic workflows. We will cover these explicitly. Certification preparation is one track; backend reliability and system design are a second track that deliberately goes beyond the exam.

This roadmap is a learning plan, not a promise of a passing result or a substitute for practical experience. AWS describes its target candidate as having roughly a year of AWS ML engineering experience and a year in a related technical role. We will advance by demonstrated competence, not by a calendar alone.

## Starting point

Already demonstrated in this project:
- TypeScript gateway and Python sentiment inference service; validation and error handling.
- Docker images, Compose networking, health checks, and automated integration checks.
- Request-ID correlation and structured logs.
- Scoped IAM, GitHub OIDC, immutable ECR image publication.
- ECS/Fargate deployment, scheduled shutdown, and stopped-service task-definition rollback.

Important limits:
- The sentiment model is a tiny teaching model, not a validated production model.
- Request IDs provide correlation; we have not demonstrated full distributed tracing.
- The rollback exercise changed the task-definition revision while stopped. It did not demonstrate recovery from a bad live model release.
- SageMaker, managed ML pipelines, data quality, drift, and GenAI are upcoming work.
- Keep ECS stopped between cloud exercises.

## Study rhythm

Keep Friday's main lab at 1–2 hours. Add two 45-minute sessions for ML/AWS theory and backend design, plus a 30-minute review when possible: approximately 3–4 hours weekly.

The table contains 16 modules. A module can take multiple weeks. Plan for approximately 16–24 weeks initially and extend whenever a checkpoint exposes a gap. At only 1–2 hours weekly, allow a longer timeline.

Every module follows the same teaching loop:
1. Explain the concept in plain language and work through a small numerical example.
2. Predict the system's behavior before running it.
3. Implement a small change in this repository.
4. Observe success and inject one controlled failure.
5. Explain the result and the tradeoff without reading the tutorial.
6. Record evidence, answer original exam-style scenarios, and verify cleanup.

## Exam coverage

| Domain | Updated guide weighting | Principal modules |
| --- | --- | --- |
| D1: Data preparation for ML and AI | 28% | 2, 3, 4, 12 |
| D2: ML model and foundation model development | 24% | 2, 5, 6, 12, 13 |
| D3: Deployment and orchestration | 24% | 7, 8, 9, 11, 14, 15 |
| D4: Operating, monitoring, and securing solutions | 24% | 1, 9, 10, 11, 13, 14, 15 |

This is our teaching allocation. Many modules touch more than one domain.

## Challenges

| Module | ML theory and practical task | AWS services to understand or exercise | Backend/reliability exercise and evidence |
| --- | --- | --- | --- |
| 1. Explain the system we built | Trace data, model, and artifact versions through an inference request. Distinguish availability from prediction quality. | ECS, ECR, IAM, STS/OIDC, VPC, CloudWatch, Scheduler | Explain ports, shared task networking, deadlines, health checks, and desired count. Produce an architecture sketch and shutdown/rollback checklist. |
| 2. Evaluate the sentiment baseline | Labels, confusion matrix, precision, recall, F1, accuracy, class imbalance, thresholds, probability versus calibration. Create a labeled evaluation set and report. | SageMaker evaluation concepts; local execution first | Add a reproducible evaluation command. Demonstrate why HTTP 200 can contain a poor prediction. Record failure examples and limitations. |
| 3. Make trustworthy datasets | Sampling, train/validation/test splits, stratification, leakage, duplicates, missing values, label quality, and reproducible seeds. | S3, Glue Data Catalog, Athena; compare CSV and Parquet | Validate schemas and dataset lineage. Inject malformed and duplicate records. Produce a versioned dataset manifest and ingestion contract. |
| 4. Build the feature pipeline | Tokenization, TF-IDF, encoding, scaling, feature selection, train/serve skew, feature freshness. | Glue, SageMaker Processing/Data Wrangler/Feature Store; compare batch with Kinesis streaming | Separate fit from transform. Test preprocessing parity and replay safely after failure. Produce a pipeline and service-choice decision note. |
| 5. Understand training | Vectors, dot products, descriptive statistics, conditional probability, sigmoid, log loss, gradient intuition. Compare logistic regression and tree models; explain bias/variance and regularization. | SageMaker training, built-in algorithms versus script mode | Move training out of application startup. Package an artifact with dependencies and metadata. Demonstrate loading and compatibility failures. |
| 6. Run reproducible experiments | Hyperparameters versus learned parameters, cross-validation, early stopping, overfitting, tuning, explainability, and fairness slices. | SageMaker automatic tuning, MLflow, Clarify concepts | Track code/data/config/metrics together. Select using validation data; use the held-out test for final assessment. Produce a model card and selection rationale. |
| 7. Learn managed ML on AWS | Processing → training → evaluation → registration; model registry approvals and lineage. | SageMaker AI jobs, Pipelines, Model Registry, S3, execution roles | Run one small CPU job if account eligibility and price permit. Handle failed steps without publishing a bad artifact. Produce pipeline evidence; local equivalent if blocked. |
| 8. Choose inference infrastructure | Real-time, asynchronous, batch, serverless, multi-model options; CPU/GPU, latency, throughput, and utilization. | SageMaker endpoint options, Batch Transform; compare ECS and Lambda | Design sync versus queued prediction APIs. Explain idempotency, polling, queue backlog, and backpressure. Use a local load test and a deployment decision table. |
| 9. Make releases reproducible | Model/code/data versions, quality gates, promotion, approval, canary/shadow/A/B, and rollback triggers. | ECR, ECS, SageMaker variants/registry; compare GitHub Actions with CodePipeline/CodeBuild/CodeDeploy | Add infrastructure as code with narrowly scoped roles and a teardown path. Test a genuinely different model release and controlled recovery locally before any cloud drill. |
| 10. Measure reliability and quality | Data drift versus concept drift, delayed labels, feedback loops, quality decay, and retraining criteria. | CloudWatch, SageMaker Model Monitor, SNS; tracing concepts including X-Ray/OpenTelemetry | Define availability and latency SLIs/SLOs, error budgets, useful alerts, and model-quality signals. Correlate one request across services and debug an injected failure. |
| 11. Survive dependency failures | Recovery objectives, batch versus online consistency, and freshness requirements. | SQS/DLQ, Step Functions, EventBridge; compare DynamoDB and RDS for state | Bounded retries with jitter, timeout budgets, circuit breakers, caching, concurrency limits, idempotency, and queue redrive. Produce a failure matrix and runbook. |
| 12. Understand foundation models and RAG | Tokens, embeddings, transformer intuition, context windows, chunking, retrieval, vector similarity, grounding, prompt versus RAG versus fine-tuning. | Bedrock, Knowledge Bases; compare OpenSearch, pgvector, and S3 vector options | Build a small local retrieval baseline and an evaluation set. Add a tightly bounded Bedrock exercise if eligible. Measure retrieval quality separately from answer quality. |
| 13. Evaluate and secure GenAI | Hallucination, prompt injection, privacy, human evaluation, automated judges and their limits, fine-tuning/LoRA concepts, responsible AI. | Bedrock evaluation/Guardrails, SageMaker tuning concepts, KMS, IAM, Secrets Manager, CloudTrail | Redact sensitive logs, bound input/output and token costs, validate responses, and restrict data access. Produce a threat model and evaluation report. |
| 14. Build bounded agent workflows | Tool use, agent state, stopping conditions, nondeterminism, task completion metrics, and tool failure. | Bedrock agents/AgentCore concepts, Step Functions, CloudWatch | Implement an allowlisted tool workflow with schema validation, per-tool permissions, time/step/cost limits, and safe recovery. Start locally; managed agents optional. |
| 15. Defend the system design | Capacity planning, scaling signals, quotas, cost-performance tradeoffs, training/serving separation, availability and disaster recovery. | AWS compute/storage/networking tradeoffs, Auto Scaling, monitoring/security services | Defend the same service at 10, 1,000, and 100,000 requests/minute on paper. Exercise smaller loads locally. Explain single points of failure, multi-AZ, RTO/RPO, and cost. |
| 16. Capstone and readiness | Rebuild a reproducible dataset-to-model-to-release path with documented quality and operational gates. | Review all four domains and AWS service-selection scenarios | Diagnose an unfamiliar incident, recover safely, explain the architecture, and complete fresh timed practice assessments. Close remaining domain gaps before booking. |

Service names in the table are a syllabus, not instructions to provision everything. For each service, learn its purpose, when to choose it, when not to choose it, security boundaries, failure behavior, and cost drivers. AWS-native CI/CD must be understood even though our working pipeline uses GitHub Actions.

## First upcoming challenge: model evaluation

Keep ECS stopped. This exercise runs locally.

Outcome: a reproducible report for sentiment-demo-v1 that tells us where it works and where it fails.

1. Explain precision and recall with a small confusion matrix before coding.
2. Create a small, balanced, manually labeled evaluation dataset that is separate from the original training examples. Include negation, mixed sentiment, unseen vocabulary, and ambiguous inputs.
3. Decide how ambiguous or neutral examples should be handled by a binary classifier. Record the limitation rather than forcing misleading labels.
4. Use validation examples for iteration and preserve a separate final test set. Do not repeatedly tune against the final test.
5. Report confusion matrix, precision, recall, F1, sample counts, and concrete mistakes. Small samples are learning evidence, not a production-quality guarantee.
6. Check deterministic runs and save model version, dataset version, and configuration in the report.
7. Define a proposed release quality gate before evaluating a future candidate. Do not lower it merely to make CI green.
8. Explain why the earlier confidence near 0.54 is a model output, not proof of calibrated certainty.

Suggested repository deliverables: evaluation data, evaluation script, model card, and a short report. No cloud endpoint is needed.

## Budget and account constraints

Original allowance: $100 AWS credits. Current remaining credits must be checked before paid cloud exercises. Keep a reserve of at least $20 of the original allowance where still available; adjust the remaining learning budget to actual usage.

- Remain on the AWS Free Plan while that is the user's chosen constraint. Do not upgrade as part of a lab.
- Verify service eligibility, Mumbai availability, current regional pricing, and estimated cost before provisioning.
- Default to local CPU training, small datasets, simulations, and short cloud sessions.
- Set job duration and request/token limits where supported; verify shutdown and resource deletion.
- Avoid persistent GPU endpoints, always-on notebooks, NAT gateways, load balancers, and EKS clusters for these labs unless a later explicit budget decision supports them.
- Budgets are alerts, not hard spending caps. Scheduler shutdowns can fail; verify stopped/deleted resources and investigate failures.
- Check storage, logs, networking, and orphaned resources as well as compute.
- A cloud lab that is unavailable on the Free Plan gets a local equivalent plus an AWS architecture walkthrough. Never upgrade silently to complete it.

## Readiness gates

For each module, explain the concept, reproduce the central exercise, diagnose one failure, and justify the AWS service choice. Keep a learning log of misconceptions and corrections.

Before booking:
- Complete fresh timed practice assessments consistently; use 80–85% as our study target, not an AWS passing-score conversion.
- Revisit every weak domain and explain why distractor options are wrong.
- Demonstrate artifact/data lineage, evaluation, least privilege, deployment, failure diagnosis, cleanup, and recovery.
- Give a five-minute architecture explanation with latency, reliability, security, and cost tradeoffs.
- Recheck the current official exam guide and exam availability.

AWS's published non-beta minimum is a scaled score of 720; that is not the same as 72% correct. Beta details can differ.

After the associate preparation, consider AWS MLOps Demonstrated as an optional practical credential. Choose additional certifications only if they serve a concrete role goal; do not stack exams before building understanding.

## Official references

- [Current detailed exam guide](https://docs.aws.amazon.com/aws-certification/latest/machine-learning-engineer-associate-02/machine-learning-engineer-associate-02.html)
- [Certification overview and current registration information](https://aws.amazon.com/certification/certified-machine-learning-engineer-associate/)
- [Data preparation domain](https://docs.aws.amazon.com/aws-certification/latest/machine-learning-engineer-associate-02/machine-learning-engineer-associate-02-domain1.html)
- [Model development domain](https://docs.aws.amazon.com/aws-certification/latest/machine-learning-engineer-associate-02/machine-learning-engineer-associate-02-domain2.html)
- [Deployment domain](https://docs.aws.amazon.com/aws-certification/latest/machine-learning-engineer-associate-02/machine-learning-engineer-associate-02-domain3.html)
- [Operations and security domain](https://docs.aws.amazon.com/aws-certification/latest/machine-learning-engineer-associate-02/machine-learning-engineer-associate-02-domain4.html)
