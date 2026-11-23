#!/usr/bin/env python3
"""Notify IndexNow after verifying the generated site's public sitemap and key."""
from datetime import datetime, timezone
import json
import argparse
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

parser=argparse.ArgumentParser()
parser.add_argument('--endpoint', choices=['https://api.indexnow.org/indexnow','https://www.bing.com/indexnow','https://yandex.com/indexnow'], default='https://api.indexnow.org/indexnow')
parser.add_argument('--site-dir', default=str(Path(__file__).resolve().parents[1]))
args=parser.parse_args()
root = Path(args.site_dir).resolve()
payload = json.loads((root / 'dist/indexnow.json').read_text())
assert urlsplit(payload['keyLocation']).scheme == 'https'
assert urlsplit(payload['keyLocation']).netloc == payload['host']
assert all(urlsplit(url).netloc == payload['host'] for url in payload['urlList'])
with urlopen(payload['keyLocation'], timeout=30) as response:
    assert response.read().decode().strip() == payload['key'], 'Public key differs from this build'
with urlopen('https://' + payload['host'] + '/sitemap.xml', timeout=30) as response:
    sitemap = ET.fromstring(response.read())
urls = [e.text for e in sitemap.findall('{http://www.sitemaps.org/schemas/sitemap/0.9}url/{http://www.sitemaps.org/schemas/sitemap/0.9}loc')]
assert urls == payload['urlList'], 'Public sitemap differs from this build'
request = Request(args.endpoint, data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json; charset=utf-8'}, method='POST')
try:
    with urlopen(request, timeout=40) as response:
        status = response.status
except HTTPError as error:
    status = error.code
result = {'submittedAtUTC': datetime.now(timezone.utc).isoformat(), 'endpoint': args.endpoint, 'httpStatus': status, 'urlCount': len(urls), 'meaning': {200: 'URLs submitted successfully; indexing not confirmed', 202: 'URLs received; key validation pending; indexing not confirmed'}.get(status, 'Submission failed; inspect the endpoint response before retrying')}
report_file = root / 'deployment-results.json'
report = json.loads(report_file.read_text()) if report_file.exists() else {}
report.setdefault('indexNowHistory',[]).append(result)
report['indexNow'] = result
report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps(result, ensure_ascii=False))
if status not in (200, 202): raise SystemExit(1)
