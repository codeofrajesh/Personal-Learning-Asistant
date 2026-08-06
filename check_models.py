import requests

api_key = 'sk-a8ie0qt25nmn1xpqjm4ayhwej7ezwj1n'
url = 'https://api.b.ai/v1/models'
headers = {'Authorization': f'Bearer {api_key}'}

res = requests.get(url, headers=headers)
models = [m['id'] for m in res.json()['data']]
print(f'Found {len(models)} models.')

free_models = []
for m in models:
    try:
        r = requests.post(
            'https://api.b.ai/v1/chat/completions',
            headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
            json={'model': m, 'messages': [{'role': 'user', 'content': 'hi'}], 'max_tokens': 1},
            timeout=5
        )
        if r.status_code == 200:
            free_models.append(m)
            print(f'Model {m} is WORKING (Free).')
        elif r.status_code == 403:
            pass # print(f'Model {m} requires deposit.')
        else:
            print(f'Model {m} returned status {r.status_code}.')
    except Exception as e:
        print(f'Model {m} failed with error: {e}')

print('All working models:', free_models)
