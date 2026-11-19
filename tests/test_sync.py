import unittest
from scripts.sync_ebooksunnah import public_url, classify, read_label, SAMPLE

class TestPublicLinks(unittest.TestCase):
    def test_label(self):
        for label in ['Baca (450 KB)', 'Baca Ebook', 'Baca sekarang']:
            self.assertTrue(read_label(label))
        for label in ['Unduh PDF', 'Baca PDF dari HP', 'Login untuk baca']:
            self.assertFalse(read_label(label))
    def test_public_url(self):
        self.assertEqual(public_url('/reader/4199'), 'https://ebooksunnah.com/reader/4199')
        for value in ['https://evil.example/read','https://ebooksunnah.com/a.pdf?token=secret','http://ebooksunnah.com/a','https://user@ebooksunnah.com/a','blob:foo','javascript:alert(1)']:
            self.assertIsNone(public_url(value))
    def test_classify(self):
        self.assertEqual(classify([{'url':'/example.pdf','label':'Unduh PDF (450 KB)','kind':'link'}], SAMPLE), {'pdf':'https://ebooksunnah.com/example.pdf'})
        self.assertEqual(classify([{'url':'/reader/4199','label':'Baca (450 KB)','kind':'link'}], SAMPLE), {'reader':'https://ebooksunnah.com/reader/4199'})
        self.assertEqual(classify([{'url':'/example.pdf?signature=secret','label':'Baca','kind':'link'}], SAMPLE), {})
        self.assertEqual(classify([{'url':'/biografi/example','label':'Buku lain','kind':'link'}], SAMPLE), {})

if __name__ == '__main__': unittest.main()
