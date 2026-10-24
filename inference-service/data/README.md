# Dataset attribution and scope

`amazon_cells_labelled.txt` is an unchanged copy of the Amazon subset of:

Kotzias, D. (2015). *Sentiment Labelled Sentences* [Dataset].
UCI Machine Learning Repository. https://doi.org/10.24432/C57604

Source: https://archive.ics.uci.edu/dataset/331/sentiment+labelled+sentences
License: Creative Commons Attribution 4.0 International (CC BY 4.0).
https://creativecommons.org/licenses/by/4.0/

Related paper: Kotzias, Denil, de Freitas, and Smyth (2015),
*From Group to Individual Labels Using Deep Features*, KDD.

The full dataset has 3,000 sentences from Amazon, IMDb, and Yelp. This lab uses
only the 1,000 Amazon sentences: 500 positive (1), 500 negative (0).
Each line is sentence, tab, label. It is overall sentence sentiment, not a newly
annotated product-only satisfaction dataset; don't relabel it implicitly.

No account or API token is needed. The copy is included for offline training.
`python download_data.py` optionally restores the exact snapshot from UCI and
verifies both archive and subset SHA-256 before writing. If UCI changes its
archive, review it rather than bypassing the checksum.

Training removes normalized exact duplicates and rejects conflicting labels.
This is a small, old, selected binary dataset with no neutral examples. Exact
normalization does not detect every near-duplicate or shared review source.
A random sentence split is a learning benchmark, not proof of generalization to
new products, review authors, languages, or future customer traffic.
