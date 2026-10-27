"""اختبار مصافحة MCP الحقيقية عبر stdio: القائمة والأدوات الست."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

try:
    import anyio
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    HAVE_MCP = True
except ModuleNotFoundError:  # pragma: no cover - بيئة بلا حزم MCP
    HAVE_MCP = False

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
EXPECTED_TOOLS = {
    "spider_sync_google_drive",
    "spider_search_knowledge",
    "spider_read_document",
    "spider_explore_network",
    "spider_list_sources",
    "spider_graph_stats",
}


@unittest.skipUnless(HAVE_MCP, "حزمة MCP غير مثبتة في هذه البيئة")
class McpServerHandshakeTests(unittest.TestCase):
    def test_stdio_lists_exactly_six_tools(self):
        async def scenario() -> set[str]:
            with tempfile.TemporaryDirectory() as tmp:
                env = {
                    **os.environ,
                    "CELIA_SPIDER_DATA_DIR": tmp,
                    "PYTHONPATH": str(PACKAGE_ROOT),
                }
                params = StdioServerParameters(
                    command=sys.executable,
                    args=["-m", "celia_spider.server"],
                    env=env,
                    cwd=str(PACKAGE_ROOT),
                )
                async with stdio_client(params) as (read, write):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        tools = await session.list_tools()
                        return {tool.name for tool in tools.tools}

        names = anyio.run(scenario)
        self.assertEqual(names, EXPECTED_TOOLS)


if __name__ == "__main__":
    unittest.main()
