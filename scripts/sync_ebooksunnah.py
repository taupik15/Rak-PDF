#!/usr/bin/env python3
"""Refresh public catalog metadata and discover public reading links, never mirror PDFs."""
import argparse
import datetime as dt
import json
import re
import time
from pathlib import Path
from urllib.parse import urljoin, urlsplit, parse_qs

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / 'data/ebooksunnah.json'
ORIGIN = 'https://ebooksunnah.com/'
SAMPLE = ORIGIN + 'muslimah-dan-keluarga/untuk-suamiku'
HOSTS = {'ebooksunnah.com', 'www.ebooksunnah.com'}


def public_url(value, base=ORIGIN):
    if not value or not isinstance(value, str):
        return None
    if value.strip().startswith(('#', 'javascript:', 'blob:', 'data:')):
        return None
    url = urljoin(base, value.strip())
    try:
        p = urlsplit(url)
        if p.scheme != 'https' or p.hostname not in HOSTS or p.username or p.password or p.port not in (None, 443):
            return None
    except ValueError:
        return None
    # Never persist session-bound, signed, expiring, or otherwise opaque query strings.
    if p.query and not all(k in {'id', 'book', 'ebook', 'page'} and all(v.isdigit() for v in vs)
                           for k, vs in parse_qs(p.query, keep_blank_values=True).items()):
        return None
    if re.search(r'/(?:login|register|premium|auth|subscribe|checkout)(?:/|$)', p.path.lower()):
        return None
    return p._replace(fragment='').geturl()


def pdf_url(value, base=ORIGIN):
    url = public_url(value, base)
    return url if url and urlsplit(url).path.lower().endswith('.pdf') else None


def read_label(value):
    return bool(re.fullmatch(r'(?:baca(?:\s+ebook)?|baca\s+sekarang)(?:\s*\([\d.,]+\s*(?:kb|mb|gb)\))?', ' '.join((value or '').lower().split())))


def classify(rows, base):
    pdf = reader = None
    for row in rows:
        url = public_url(row.get('url'), base)
        if not url or url == base:
            continue
        label = row.get('label', '')
        kind = row.get('kind', '')
        if pdf_url(url) and (read_label(label) or re.search(r'\b(?:unduh|download)\b', label, re.I) or kind == 'embed' or row.get('type') == 'application/pdf'):
            pdf = pdf or url
        elif read_label(label) and kind == 'link':
            # This is a visible reading link, not an inferred endpoint.
            reader = reader or url
    return {k: v for k, v in [('pdf', pdf), ('reader', reader)] if v}


ROWS_JS = '''() => [...document.querySelectorAll('a[href], iframe[src], embed[src], object[data]')]
 .filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
 .map(e => ({kind:e.tagName==='A'?'link':'embed',url:e.getAttribute('href')||e.getAttribute('src')||e.getAttribute('data'),label:(e.innerText||e.getAttribute('aria-label')||e.title||'').trim(),type:e.getAttribute('type')||''}))'''


def inspect_book(context, source):
    page = context.new_page()
    try:
        response = page.goto(source, timeout=35000, wait_until='domcontentloaded')
        if not response or response.status >= 400 or not public_url(page.url):
            raise RuntimeError(f'HTTP {response.status if response else "?"}')
        page.wait_for_timeout(900)
        if re.search(r'captcha|just a moment|access denied', page.title(), re.I):
            raise RuntimeError('access restricted')
        rows = page.evaluate(ROWS_JS)
        result = classify(rows, source)
        if result.get('pdf') or result.get('reader'):
            return result
        # A normal public Baca button may use client-side routing. Never click login,
        # download, premium, CAPTCHA or subscription controls, or forge network calls.
        controls = page.get_by_role('button').all() + page.get_by_role('link').all()
        for control in controls:
            if not control.is_visible():
                continue
            label = control.inner_text(timeout=2000).strip() or control.get_attribute('aria-label') or ''
            if not read_label(label):
                continue
            before = set(context.pages)
            try:
                control.click(timeout=4000, no_wait_after=True)
                page.wait_for_timeout(3500)
            except Exception:
                break
            for opened in [page] + [p for p in context.pages if p not in before]:
                if opened.is_closed():
                    continue
                url = public_url(opened.url)
                if not url:
                    continue
                if url != source:
                    path = urlsplit(url).path.lower()
                    if pdf_url(url):
                        result['pdf'] = url
                    elif not re.search(r'/(?:login|register|premium|auth|subscribe|checkout)(?:/|$)', path):
                        result['reader'] = url
                try:
                    result.update(classify(opened.evaluate(ROWS_JS), url))
                    # Public PDF links in visible reader frames are okay. No response interception.
                    for frame in opened.frames[1:]:
                        link = pdf_url(frame.url)
                        if link:
                            result['pdf'] = link
                except Exception:
                    pass
            break
        return result
    finally:
        for opened in list(context.pages):
            opened.close()


def refresh_latest(context, books):
    known = {b['source']: b for b in books}
    categories = {}
    for b in books:
        path = urlsplit(b['source']).path.strip('/').split('/')
        if len(path) == 2 and b.get('categories'):
            categories.setdefault(path[0], b['categories'][0])
    page = context.new_page()
    added = []
    try:
        response = page.goto(ORIGIN, timeout=35000, wait_until='domcontentloaded')
        if not response or response.status >= 400:
            raise RuntimeError('catalog HTTP error')
        page.wait_for_timeout(900)
        if re.search(r'captcha|just a moment|access denied', page.title(), re.I):
            raise RuntimeError('access restricted')
        for row in page.evaluate(ROWS_JS):
            url = public_url(row['url'])
            title = ' '.join(row['label'].split())
            path = urlsplit(url).path.strip('/').split('/') if url else []
            if len(path) != 2 or path[0] not in categories or not title or len(title) > 350 or url in known:
                continue
            if re.fullmatch(r'\d+|lihat.*|baca.*|selengkapnya', title, re.I):
                continue
            book = {'title': title, 'categories': [categories[path[0]]], 'source': url}
            known[url] = book
            added.append(book)
        if added:
            books[:0] = added
        return len(added)
    finally:
        page.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=40)
    parser.add_argument('--only', help='Inspect a specific catalog detail URL')
    parser.add_argument('--skip-latest', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.limit <= 150:
        parser.error('--limit must be 1–150')
    from playwright.sync_api import sync_playwright
    data = json.loads(CATALOG.read_text())
    books = data['books']
    now = dt.datetime.now(dt.timezone.utc)
    today = now.date().isoformat()
    def due(b):
        try:
            age = (now.date() - dt.date.fromisoformat(b['checked_at'])).days
        except (ValueError, KeyError):
            return True
        return age >= (30 if b.get('pdf') or b.get('reader') else 7)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(accept_downloads=False)
        # No stored login state; no credentials or third-party proxy.
        if not args.skip_latest and not args.only:
            try:
                print('New homepage titles:', refresh_latest(context, books))
                data['last_catalog_check'] = today
            except Exception as e:
                print('Catalog refresh failed:', type(e).__name__)
        if args.only:
            candidates = [b for b in books if b['source'] == args.only]
            if not candidates:
                parser.error('URL not in local catalog')
        else:
            candidates = sorted((b for b in books if due(b)), key=lambda b: (b['source'] != SAMPLE, bool(b.get('checked_at')), b.get('checked_at','')))[:args.limit]
        failures = 0
        success = 0
        for b in candidates:
            try:
                found = inspect_book(context, b['source'])
                if found:
                    for key in ('pdf', 'reader'):
                        if key in found:
                            b[key] = found[key]
                b['checked_at'] = today
                b['read_status'] = 'available' if b.get('pdf') or b.get('reader') else 'not-found'
                success += 1
                failures = 0
                print(b['title'], '→', ','.join(found) or 'no public reading URL detected', flush=True)
            except Exception as e:
                # Keep prior known links and don't mark inaccessible pages as checked.
                failures += 1
                print(b['title'], '→', type(e).__name__, flush=True)
                if failures >= 3:
                    print('Stopping after three consecutive failures; respect source availability.')
                    break
            time.sleep(2)
        browser.close()
    if success:
        data['last_link_sync'] = today
    temp = CATALOG.with_suffix('.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n')
    temp.replace(CATALOG)
    print('Total:',len(books),'public links:',sum(bool(b.get('pdf') or b.get('reader')) for b in books))
    if candidates and not success:
        raise SystemExit('No detail page could be inspected; previous links preserved.')

if __name__ == '__main__':
    main()
