#!/usr/bin/env python3
"""Validate the generated public site, or verify its exact HTML after deployment."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit, urljoin
from urllib.request import Request, urlopen
from urllib.robotparser import RobotFileParser
import xml.etree.ElementTree as ET


class Page(HTMLParser):
    def __init__(self, content):
        super().__init__()
        self.meta = {}
        self.canonicals = []
        self.links = []
        self.ids = []
        self.schema = []
        self.h1 = 0
        self.title = ''
        self.visible = []
        self.in_title = False
        self.in_json = False
        self.json_text = ''
        self.feed(content)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if 'id' in a: self.ids.append(a['id'])
        if tag == 'h1': self.h1 += 1
        if tag == 'title': self.in_title = True
        if tag == 'meta': self.meta[a.get('name', a.get('property'))] = a.get('content')
        if tag == 'link' and a.get('rel') == 'canonical': self.canonicals.append(a.get('href'))
        if tag == 'script' and a.get('type') == 'application/ld+json':
            self.in_json = True
            self.json_text = ''
        for attr in ('href', 'src', 'poster'):
            if attr in a: self.links.append(a[attr])

    def handle_data(self, data):
        if self.in_title: self.title += data
        if self.in_json: self.json_text += data
        else: self.visible.append(data)

    def handle_endtag(self, tag):
        if tag == 'title': self.in_title = False
        if tag == 'script' and self.in_json:
            self.schema.extend(json.loads(self.json_text)['@graph'])
            self.in_json = False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', default=str(Path(__file__).resolve().parents[1] / 'dist'))
    parser.add_argument('--live', help='Also compare deployed HTML with this build, e.g. https://openworkbuddy.work')
    args = parser.parse_args()
    out = Path(args.directory).resolve()
    ns = {'s': 'http://www.sitemaps.org/schemas/sitemap/0.9'}
    urls = [e.text for e in ET.parse(out / 'sitemap.xml').findall('s:url/s:loc', ns)]
    assert urls and len(urls) == len(set(urls)), 'Missing or duplicate sitemap URLs'
    origin = urls[0].rstrip('/')
    pages = {}
    titles, descriptions = [], []
    for url in urls:
        parts = urlsplit(url)
        assert f'{parts.scheme}://{parts.netloc}' == origin, url
        path = parts.path
        file = out / path.lstrip('/') / 'index.html'
        raw = file.read_text()
        page = Page(raw)
        pages[path] = page
        assert page.h1 == 1, (path, 'Expected one H1')
        assert page.canonicals == [url], (path, 'Incorrect canonical')
        assert page.meta.get('description'), (path, 'Missing description')
        assert page.meta.get('baidu-site-verification') == 'codeva-JuFY12Ro3O', (path, 'Missing Baidu verification')
        assert page.meta.get('og:url') == url, (path, 'Incorrect OG URL')
        assert 'noindex' not in page.meta.get('robots', ''), path
        assert len(page.ids) == len(set(page.ids)), (path, 'Duplicate IDs')
        assert '<' not in page.title and '{BASE}' not in raw, path
        assert not re.search(r'/Users/|AIza[\w-]{30,}|sk-[\w-]{35,}', raw), (path, 'Private data pattern')
        if urlsplit(origin).hostname == 'openworkbuddy.work':
            assert 'https://beian.miit.gov.cn/' in raw and '粤ICP备2026086918号</a>' in raw, (path, 'Missing confirmed Guangdong filing')
        types = {s['@type'] for s in page.schema}
        assert {'WebSite', 'WebPage', 'SoftwareApplication', 'SoftwareSourceCode'} <= types, path
        for node in page.schema:
            if node['@type'] == 'FAQPage':
                visible = ''.join(page.visible)
                for q in node['mainEntity']:
                    assert q['name'] in visible and q['acceptedAnswer']['text'] in visible, (path, 'Hidden FAQ')
            if node['@type'] == 'TechArticle':
                assert '<' not in node['headline'], (path, 'HTML in headline')
                assert node['datePublished'] <= node['dateModified'], (path, 'Invalid dates')
        titles.append(page.title)
        descriptions.append(page.meta['description'])
    assert all(v == 1 for v in Counter(titles).values()), 'Duplicate titles'
    assert all(v == 1 for v in Counter(descriptions).values()), 'Duplicate descriptions'
    links = 0
    for path, page in pages.items():
        for link in page.links:
            url = urlsplit(urljoin(origin + path, link))
            if url.scheme not in ('http', 'https') or url.netloc != urlsplit(origin).netloc:
                continue
            target = unquote(url.path)
            file = out / target.lstrip('/')
            if file.is_dir(): file /= 'index.html'
            assert file.is_file(), (path, 'Broken link', link)
            if url.fragment and target in pages:
                assert unquote(url.fragment) in pages[target].ids, (path, 'Broken fragment', link)
            links += 1
    error = Page((out / '404.html').read_text())
    assert 'noindex' in error.meta['robots']
    robot = RobotFileParser()
    robot.parse((out / 'robots.txt').read_text().splitlines())
    for agent in ('Googlebot', 'Bingbot', 'Baiduspider', 'OAI-SearchBot', 'ChatGPT-User', 'Claude-SearchBot', 'PerplexityBot'):
        assert all(robot.can_fetch(agent, url) for url in urls), agent
    submission = json.loads((out / 'indexnow.json').read_text())
    assert submission['urlList'] == urls
    assert (out / (submission['key'] + '.txt')).read_text() == submission['key']
    for url in urls:
        assert url in (out / 'llms.txt').read_text() and url in (out / 'llms-full.txt').read_text(), url
    if args.live:
        def check(url):
            path = urlsplit(url).path
            deployed = args.live.rstrip('/') + path
            with urlopen(Request(deployed, headers={'Cache-Control': 'no-cache'}), timeout=30) as response:
                assert response.status == 200 and response.headers.get_content_type() == 'text/html', deployed
                assert response.read() == (out / path.lstrip('/') / 'index.html').read_bytes(), (path, 'Deployment differs')
            return path
        with ThreadPoolExecutor(max_workers=5) as pool:
            assert len(list(pool.map(check, urls))) == len(urls)
        print(f'Live HTML matches build: {len(urls)} pages')
    print(f'PASS: {len(urls)} indexable pages, {links} internal links/assets; metadata, JSON-LD, visible FAQs, robots, sitemap, AI text and IndexNow key')


if __name__ == '__main__':
    main()
