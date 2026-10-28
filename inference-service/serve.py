"""SageMaker's `docker run IMAGE serve` entry point; serving never trains."""
import argparse

import uvicorn


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["serve"])
    parser.parse_args()
    uvicorn.run("app:app", host="0.0.0.0", port=8080, workers=1,
                timeout_graceful_shutdown=25)


if __name__ == "__main__":
    main()
