import urllib.request
import urllib.error
import json
import time

keys = [
    "em_live_cb147aa7c2f3a8deebbab79d24f55504",
    "em_live_3de3902aa88b0e1316d31a3ed0327229",
    "em_live_146cad659cbc7b23f30ec4ae0152889d"
]

models = [
    "euromodels/claude-fable-5",
    "euromodels/claude-opus-5"
]

url = "https://euromodels.xyz/v1/messages"

print("Starting EuroModels Proxy Benchmark...\n")

for key in keys:
    print(f"Testing key: {key[:12]}...")
    for model in models:
        data = {
            "model": model,
            "max_tokens": 10,
            "messages": [{"role": "user", "content": "Hi!"}]
        }
        headers = {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json"
        }
        req = urllib.request.Request(url, data=json.dumps(data).encode("utf-8"), headers=headers, method="POST")
        
        start_time = time.time()
        try:
            with urllib.request.urlopen(req) as response:
                res = response.read()
                print(f"  Model {model.split('/')[-1]}: SUCCESS in {time.time() - start_time:.2f} seconds")
        except urllib.error.HTTPError as e:
            try:
                error_body = e.read().decode('utf-8')
                print(f"  Model {model.split('/')[-1]}: FAILED (HTTP {e.code}) in {time.time() - start_time:.2f} seconds. Details: {error_body}")
            except:
                print(f"  Model {model.split('/')[-1]}: FAILED (HTTP {e.code}) in {time.time() - start_time:.2f} seconds.")
        except Exception as e:
            print(f"  Model {model.split('/')[-1]}: ERROR - {str(e)}")
    print("-" * 50)
