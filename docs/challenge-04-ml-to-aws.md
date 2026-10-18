# Challenge #4: from free review data to a versioned model on AWS

## The two paths

You know how to build APIs. This exercise adds a model whose data, performance,
and deployed version you can inspect.

- **Build path:** labelled data → split → train → evaluate → save bundle → image.
- **Request path:** TypeScript gateway → FastAPI → saved model → prediction.

Before: FastAPI fitted a classifier on 12 hard-coded examples at every startup.
After: an explicit training command fits on real labelled data. FastAPI loads the
result and never trains. Supplier extraction remains a separate capability; this
exercise uses sentiment classification through `/api/analyze`.

## 1. Free dataset: already included

[UCI Sentiment Labelled Sentences](https://archive.ics.uci.edu/dataset/331/sentiment+labelled+sentences)
contains 3,000 sentences from Amazon, Yelp, and IMDb. This lab uses the **Amazon
subset: 1,000 sentences, 500 positive and 500 negative**. No account, token, paid
model, or GPU is required.

`inference-service/data/amazon_cells_labelled.txt` is the unchanged source copy.
Each line contains a sentence, a tab, and a label (`1` positive; `0` negative).
These are original sentence-sentiment labels, not new product-only annotations.
Attribution, CC BY 4.0 license links, and limitations are in `data/README.md`.

The copy supports offline training after dependencies are installed. Optional
`download_data.py` restores the exact UCI snapshot, verifying both archive and
subset SHA-256. It reads one named ZIP member without extracting arbitrary paths.

## 2. Start here: Windows PowerShell

From the repository root:

```powershell
git fetch origin
git switch --track origin/feat/versioned-sentiment-aws
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r inference-service/requirements-dev.txt
cd inference-service
python train.py
```

If the local branch already exists, use `git switch feat/versioned-sentiment-aws`.
If activation is restricted, use the virtual environment's Python executable
directly; changing machine-wide execution policy is unnecessary.

Optional re-download from UCI, while inside `inference-service`:

```powershell
python download_data.py
```

For Bash use `python3.12 -m venv .venv` and `source .venv/bin/activate` from the
repository root. The subsequent Python commands are the same.

## 3. Read the code in this order

| Code | What it does |
| --- | --- |
| `dataset.read_reviews()` | Verifies bytes, parses labels, removes normalized exact duplicates |
| `train.split_reviews()` | Reserves about 20% of unique sentences for testing |
| `TfidfVectorizer()` | Converts words into numeric features |
| `LogisticRegression()` | Learns feature weights for positive/negative classification |
| `score()` | Compares predictions with real labels and a baseline |
| `joblib.dump()` | Saves the fitted vectorizer and classifier together |
| `model.load_model()` | Verifies and loads that bundle during startup |

### Split before learning anything

The test set is like an interview question the model has not seen:

```python
training, test = split_reviews(rows, seed=42)
model.fit(training_texts, training_labels)
predicted = model.predict(test_texts)
```

TF-IDF learns its vocabulary and word statistics only from training text.
Preprocessing the entire dataset before splitting would leak test information.
The pipeline makes the correct order explicit.

The split is stratified to preserve approximate class proportions. A fixed seed
makes split membership reproducible; metadata records sentence IDs for auditing.

Before splitting, the parser normalizes case/whitespace and removes identical
repeats. It rejects identical sentences with conflicting labels. This does not
catch every paraphrase or related review. The source lacks enough provenance to
guarantee author/product-group separation, so this is a sentence benchmark,
not proof of generalization to new products or real customer traffic.

### What the classifier learns

TF-IDF weights words using their frequency in a review and across training reviews.
Logistic regression learns which feature weights favor each label. The result is
a small supervised ML model, not an LLM. Negation, sarcasm, context, and unfamiliar
vocabulary can all cause failures.

## 4. Read the evaluation

Training writes three generated files, ignored by Git:

```text
artifacts/model.joblib
artifacts/metadata.json
artifacts/evaluation.json
```

Inspect them:

```powershell
Get-Content artifacts/metadata.json
Get-Content artifacts/evaluation.json
```

| Metric | Plain-English meaning |
| --- | --- |
| Accuracy | Fraction of all predictions that are correct |
| Negative precision | Of reviews called negative, how many truly are negative? |
| Negative recall | Of genuinely negative reviews, how many did we catch? |
| Macro F1 | Equal-weight average of each class's precision/recall balance |
| Confusion matrix | Counts of actual labels versus predicted labels |

The majority-class baseline always chooses the most common training label.
High accuracy on an imbalanced dataset can hide total failure on one class.

Observed locally with seed 42, Python 3.12, and the pinned dependencies:

| Measurement | Classifier | Majority baseline |
| --- | ---: | ---: |
| Accuracy | 75.76% | 50.51% |
| Macro F1 | 0.7576 | 0.3356 |
| Negative precision | 0.76 | 0.5051 |
| Negative recall | 0.76 | 1.00 |

13 repeats were removed, leaving 987 unique sentences: 789 training and 198 test.
The baseline predicts negative every time; its perfect negative recall alone is
misleading. The model's confusion matrix is:

| Actual / predicted | Negative | Positive |
| --- | ---: | ---: |
| Negative | 76 | 24 |
| Positive | 24 | 74 |

All 48 errors are recorded. Inspect five. For instance, the positive sentence
“It is a joy to use.” is classified negative. Inspect vocabulary and weights before
claiming a precise explanation.

There is no arbitrary accuracy pass mark. Honest measurement is the requirement.
If you start tuning after viewing test results, introduce a validation split and
reserve a fresh final test set. Do not repeatedly optimize against this test set.

## 5. Understand the artifact boundary

The saved pipeline contains preprocessing and classifier parameters. Metadata records
model version, source hash, seed, split membership, dependency versions, Python
version, and model checksum. FastAPI checks the checksum, Python major/minor, and
key dependency versions before loading. Missing or incompatible artifacts fail
startup clearly.

Only load bundles produced by your trusted workflow: joblib can execute code when
loading. A checksum detects changed bytes; it does not authenticate their publisher.
The API's existing `confidence` field is a maximum predicted probability, not a
calibrated probability of correctness.

## 6. Run the service and tests

From `inference-service`, with the environment active:

```powershell
python -m pytest -q
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

In another terminal, from the repository root:

```powershell
cd api-gateway
npm ci
npm test
npm run build
$env:INFERENCE_URL = "http://127.0.0.1:8000"
npm start
```

In a third terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
Invoke-RestMethod http://127.0.0.1:3000/api/analyze -Method Post -ContentType 'application/json' -Body '{"text":"Excellent quality and easy to use"}'
```

The expected version is `sentiment-uci-amazon-v1`. The label is a model prediction,
not a guarantee for a hand-picked example. Restart FastAPI and confirm the same
artifact loads without training.

Tests cover split separation, held-out vocabulary, baseline metrics, artifact
corruption, dependency mismatch, missing-artifact startup, and serving without fit.
They create a temporary bundle from vendored data; no download is needed in tests.

## 7. Docker: package code and model together

Stop local servers to release port 3000. From the repository root:

```powershell
docker compose up --build --detach --wait
Invoke-RestMethod http://127.0.0.1:3000/api/analyze -Method Post -ContentType 'application/json' -Body '{"text":"Excellent quality and easy to use"}'
docker compose logs --no-color
docker compose down
```

The Dockerfile stages are:

1. `base`: install pinned dependencies.
2. `training`: train/evaluate from vendored, checksummed data.
3. `runtime`: copy the serving code and generated bundle.

Host artifacts are excluded from Docker's context. Training/runtime inherit the
same packages. Runtime does not contain training code or the raw dataset, and
neither build nor startup needs UCI network access.

Training during image build is a lab simplification. A larger system trains in a
separate pipeline, approves an immutable artifact, then packages that exact bundle.
Record the image digest: identical source does not guarantee identical model bytes
across hardware or dependency environments.

## 8. AWS: reuse the existing protected workflows

This branch prepares code and CI without starting AWS resources. AWS workflows
remain restricted to `main`; keep their IAM trust restrictions intact.
After reviewing and merging the intended branch changes:

1. Confirm **CI** on the merged commit passes Python, TypeScript, and Docker checks.
2. Run **Publish images** on `main`. It tests, builds, smoke-tests, and publishes
   both tested images to ECR. Record the source commit and image digests.
3. Copy the exact shared `sha-...-run-...` image tag from the summary.
4. Confirm the ECS lab is stopped. Run **Deploy lab for 15 minutes** on `main`
   with that tag. The existing script requires zero tasks, resolves image digests,
   registers a task revision, and verifies an independent shutdown schedule before
   starting one task. Record old/new revisions from its summary.
5. Inspect the task's network interface/public IPv4 address in ECS. For the lab,
   restrict gateway TCP 3000 to your current public IP /32 using the existing
   security group. Do not expose inference port 8000.
6. Verify gateway `INFERENCE_URL` in the ECS task definition is
   `http://127.0.0.1:8000` for containers within the same Fargate task. Local Compose
   uses `http://inference:8000` because it has separate container networking.
7. Send a non-sensitive request to `http://TASK_PUBLIC_IP:3000/api/analyze`.
   Confirm the expected model version and copy the response's `x-request-id`.
8. In CloudWatch, find that request ID in both container streams. Their log groups
   come from the task definition's `awslogs` configuration.
9. After the shutdown deadline verify desired, running, and pending counts are zero.

The ECS execution role pulls images and ships logs. The serving application needs
no AWS credentials to load a model already inside its image.

This is a restricted temporary HTTP lab, not a public production service. Check
credits/pricing before launch; zero tasks does not delete ECR images, logs, or
other billable resources. This change requires no GPU, load balancer, NAT gateway,
new database, or new cloud service.

## 9. Rollback: be precise about what you prove

After shutdown, **Roll back stopped lab** can restore an earlier ACTIVE revision
using the revision number recorded above. Its checks keep all task counts at zero.
That proves configuration recovery, not a live prediction from the old model.

A live rollback test requires a separately reviewed timed run of the restored
revision and another API request. The existing deploy workflow creates a new
revision from published images; do not claim that it starts the restored revision
unchanged. This branch does not implement another rollback mechanism.

## 10. Your remaining hands-on work

- Explain one false positive and one false negative from the report.
- Explain why model probability is not the same as correctness.
- Run local Docker integration or inspect its branch CI result.
- Perform AWS deployment and verify prediction, version, correlated logs, shutdown.
- Perform stopped-configuration rollback and record task revisions/image digests.

The coding portion is prepared. AWS completion requires observed cloud results.
Live runtime rollback is a separate follow-up, not something the stopped workflow
has demonstrated.

## References

- Data/license: https://archive.ics.uci.edu/dataset/331/sentiment+labelled+sentences
- Leakage: https://scikit-learn.org/stable/common_pitfalls.html
- Persistence: https://scikit-learn.org/stable/model_persistence.html
- ECS execution role: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_execution_IAM_role.html
- Pricing: https://aws.amazon.com/fargate/pricing/

## Troubleshooting: dataset checksum mismatch on Windows

All tests may fail in fixture setup because they share a training bundle. This
can be one dataset problem, not ten separate model bugs. Git's `core.autocrlf`
may convert LF bytes to CRLF during checkout, changing SHA-256 without changing
visible sentences. `.gitattributes` now disables text conversion for the pinned
source file. The parser diagnoses line-ending changes but still rejects them.

From `inference-service`, inspect and restore the source:

```powershell
Get-FileHash .\data\amazon_cells_labelled.txt -Algorithm SHA256
python download_data.py
python train.py
python -m pytest -q
```

Expected SHA-256: `47003fc0a0d4840b00e96e715b6189bad09e7443a3da41c4cbe12ffc79f86ae3`.
The CRLF-converted version hashes to
`d631a137c89205e2b5091543d79d6f77e50446a11bab7bb7b9e528d46dd9a6dc`.
An existing checkout may keep its converted bytes after pulling an attributes-only
change; the verified downloader repairs that copy. Do not change the expected hash
or disable validation to make an unexplained difference pass.
