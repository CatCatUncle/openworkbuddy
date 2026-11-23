#!/usr/bin/env python3
"""Submit canonical HTTPS pages to Baidu; the push token stays in process memory."""
import argparse
from datetime import datetime, timezone, timedelta
from getpass import getpass
import json
import subprocess
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

p=argparse.ArgumentParser()
p.add_argument('--site', required=True)
p.add_argument('--report', required=True)
p.add_argument('--urls-file')
p.add_argument('--previous-report')
p.add_argument('--queue-remaining-on-server', action='store_true')
p.add_argument('--limit', type=int, default=2000)
p.add_argument('--transport', choices=['http','https'], default='http', help='Use the transport shown in the Baidu console')
a=p.parse_args()
base=a.site.rstrip('/')
assert urlsplit(base).scheme=='https' and urlsplit(base).path=='', 'Use a canonical HTTPS origin'
with urlopen(base+'/sitemap.xml',timeout=30) as r:
    root=ET.fromstring(r.read())
ns='{http://www.sitemaps.org/schemas/sitemap/0.9}'
urls=[e.text for e in root.findall(ns+'url/'+ns+'loc')]
assert urls and len(urls)==len(set(urls))
assert all(u.startswith(base+'/') and urlsplit(u).scheme=='https' for u in urls)
all_urls=list(urls)
sitemap_count=len(urls)
if a.urls_file:
    urls=Path(a.urls_file).read_text().splitlines()
    assert urls and all(u in all_urls for u in urls) and len(urls)==len(set(urls))
urls=urls[:a.limit]
token=getpass('Baidu push token (hidden): ')
assert token.strip()
endpoint=a.transport+'://data.zz.baidu.com/urls?'+'site='+base+'&token='+token.strip()
request=Request(endpoint,data=('\n'.join(urls)+'\n').encode(),headers={'Content-Type':'text/plain','User-Agent':'curl/8.7.1'},method='POST')
result={'site':base,'submittedAtUTC':datetime.now(timezone.utc).isoformat(),'submittedUrls':urls,'requestedCount':len(urls),'sitemapCount':sitemap_count}
try:
    with urlopen(request,timeout=40) as r:
        result.update(httpStatus=r.status,response=json.loads(r.read()))
except HTTPError as e:
    result['httpStatus']=e.code
    try:result['response']=json.loads(e.read())
    except Exception:result['errorType']='HTTPError'
except Exception as e:
    result['errorType']=type(e).__name__
if a.queue_remaining_on_server and result.get('httpStatus')==200 and result.get('response',{}).get('success')==len(urls):
    accepted=[]
    if a.previous_report:
        prev=json.loads(Path(a.previous_report).read_text())
        assert prev.get('site')==base and prev.get('response',{}).get('success')==len(prev['submittedUrls'])
        accepted.extend(prev['submittedUrls'])
    accepted.extend(urls)
    pending=[u for u in all_urls if u not in accepted]
    host=urlsplit(base).netloc
    assert host in {'openworkbuddy.work','zhantaiyingxiao.cn','aijentra.com'}
    now=datetime.now(timezone.utc)
    config={'site':base,'token':token.strip(),'acceptedUrls':accepted,'pendingUrls':pending,'lastAttemptLocalDate':(now+timedelta(hours=8)).date().isoformat(),'expiresAtUTC':(now+timedelta(days=7)).isoformat()}
    if pending:
        cmd='install -d -m 700 /var/lib/site-indexing/queues /var/lib/site-indexing/reports; umask 077; cat > /var/lib/site-indexing/queues/'+host+'.json'
        subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','root@121.199.165.131',cmd],input=json.dumps(config).encode(),check=True)
    result['acceptedCountIncludingPrevious']=len(accepted)
    result['queuedCount']=len(pending)
Path(a.report).write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps({k:v for k,v in result.items() if k!='submittedUrls'},ensure_ascii=False))
if result.get('httpStatus')!=200 or result.get('response',{}).get('success')!=len(urls):raise SystemExit(1)
