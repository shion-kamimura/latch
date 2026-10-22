"""Run the real prepare module with mocked GitHub APIs when Node is available."""
from pathlib import Path
import shutil
import subprocess
import unittest


class PrepareTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('node'), 'Node unavailable in Python-only verifier')
    def test_prepare_lifecycle(self):
        subprocess.run(['node', '--test', str(Path(__file__).with_suffix('.mjs'))], check=True, timeout=30)
