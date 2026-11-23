#!/usr/bin/env python3
"""Bounded daily continuation for explicitly authorized Baidu URL submissions.
Private queue files belong outside web roots, mode 0600. Credentials are removed
when a queue completes or expires; reports contain public URLs and responses only.
Compatible with Python 3.6 on the existing deployment server.
"""
from datetime import datetime, timezone, timedelta
import fcntl
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.parse import urlsplit

ROOT=Path('/var/lib/site-indexing')
QUEUES=ROOT/'queues'
REPORTS=ROOT/'reports'
ALLOWED={'openworkbuddy.work','zhantaiyingxiao.cn','aijentra.com'}


def save(path,data):
    tmp=path.with_suffix('.tmp')
    with open(str(tmp),'w') as f:
        os.chmod(str(tmp),0o600)
        json.dump(data,f,ensure_ascii=False,indent=2)
    os.replace(str(tmp),str(path))


def run():
    now=datetime.now(timezone.utc)
    today=(now+timedelta(hours=8)).date().isoformat()
    for file in sorted(QUEUES.glob('*.json')):
        cfg=json.loads(file.read_text())
        host=urlsplit(cfg['site']).netloc
        if host not in ALLOWED:continue
        public=REPORTS/(host+'.json')
        report=json.loads(public.read_text()) if public.exists() else {'site':cfg['site'],'acceptedUrls':cfg.get('acceptedUrls',[]),'attempts':[]}
        if now.isoformat()>=cfg['expiresAtUTC']:
            report.update(status='expired',pendingUrls=cfg['pendingUrls'])
            save(public,report);file.unlink();continue
        if cfg.get('lastAttemptLocalDate')==today:continue
        cfg['lastAttemptLocalDate']=today
        save(file,cfg)
        for url in list(cfg['pendingUrls'])[:20]:
            assert url.startswith(cfg['site']+'/') and urlsplit(url).netloc==host
            endpoint='http://data.zz.baidu.com/urls?site='+cfg['site']+'&token='+cfg['token']
            req=Request(endpoint,data=(url+'\n').encode(),headers={'Content-Type':'text/plain','User-Agent':'curl/8.7.1'},method='POST')
            attempt={'atUTC':datetime.now(timezone.utc).isoformat(),'url':url}
            try:
                with urlopen(req,timeout=30) as r:
                    attempt.update(httpStatus=r.status,response=json.loads(r.read()))
            except HTTPError as e:
                attempt['httpStatus']=e.code
                try:attempt['response']=json.loads(e.read())
                except Exception:attempt['errorType']='HTTPError'
            except Exception as e:
                attempt['errorType']=type(e).__name__
            report['attempts'].append(attempt)
            if attempt.get('httpStatus')==200 and attempt.get('response',{}).get('success')==1:
                cfg['pendingUrls'].remove(url)
                if url not in report['acceptedUrls']:report['acceptedUrls'].append(url)
                save(file,cfg)
                if attempt['response'].get('remain')==0:break
            else:break
        report.update(status='pending' if cfg['pendingUrls'] else 'complete',pendingUrls=cfg['pendingUrls'],updatedAtUTC=datetime.now(timezone.utc).isoformat())
        save(public,report)
        if not cfg['pendingUrls']:file.unlink()
    if not list(QUEUES.glob('*.json')):
        cron=Path('/etc/cron.d/site-indexing-queue')
        if cron.exists():cron.unlink()


if __name__=='__main__':
    REPORTS.mkdir(parents=True,exist_ok=True)
    with open(str(ROOT/'.lock'),'w') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise SystemExit(0)
        run()
