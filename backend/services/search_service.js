// backend/services/search_service.js
// 真实联网检索服务：开启联网后必须真实访问搜索引擎，禁止仅依赖内部知识库
// 主检索: DuckDuckGo HTML 端点 | 备用: Jina Reader (Bing) | 图片: Wikimedia Commons API

// ── HTML 标签净化 ─────────────────────────────────────────────────────────
function stripHtml(str) {
  return (str || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── 主检索：DuckDuckGo HTML 端点（真实搜索结果） ─────────────────────────
async function searchDuckDuckGo(query) {
  const cleanQuery = encodeURIComponent(query.substring(0, 120));
  const url = `https://html.duckduckgo.com/html/?q=${cleanQuery}`;

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!resp.ok) throw new Error(`DuckDuckGo HTTP ${resp.status}`);
  const html = await resp.text();

  const results = [];
  // 按 result 条目块拆分解析
  const blocks = html.split('class="result').slice(1);
  for (const block of blocks.slice(0, 6)) {
    const linkMatch = block.match(/result__a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const snippetMatch = block.match(/result__snippet[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    let link = linkMatch[1];
    if (link.startsWith('//')) link = 'https:' + link;
    // 解析 DDG 重定向参数还原真实地址
    const uddg = link.match(/uddg=([^&]+)/);
    if (uddg) { try { link = decodeURIComponent(uddg[1]); } catch {} }

    const title = stripHtml(linkMatch[2]);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : '';
    if (title) {
      results.push(`- 【${title}】\n  链接: ${link}\n  摘要: ${snippet}`);
    }
  }
  return results;
}

// ── 备用检索：Jina Reader 抓取 Bing ─────────────────────────────────────
async function searchViaJinaReader(query) {
  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query.substring(0, 100))}`;
  const resp = await fetch(`https://r.jina.ai/${searchUrl}`, {
    headers: { 'Accept': 'text/plain, text/markdown', 'X-Return-Format': 'markdown', 'X-Timeout': '15' },
    signal: AbortSignal.timeout(25000)
  });
  if (!resp.ok) throw new Error(`Jina Reader HTTP ${resp.status}`);
  const md = await resp.text();
  // 截取正文主体
  return md.slice(0, 6000);
}

/**
 * 真实网页检索入口：开启联网后必须真实访问搜索引擎
 * @param {string} query 搜索关键词
 */
export async function searchWeb(query) {
  // 1. DuckDuckGo 真实检索
  try {
    const results = await searchDuckDuckGo(query);
    if (results.length > 0) {
      console.log(`[SearchService] ✅ DuckDuckGo 真实检索成功 (${results.length} 条)`);
      return `【🌐 真实网络搜索结果 (DuckDuckGo)】针对 "${query}"：\n${results.join('\n')}`;
    }
  } catch (e) {
    console.warn('[SearchService] DuckDuckGo 检索失败，切换备用通道:', e.message);
  }

  // 2. 备用：Jina Reader 抓取 Bing
  try {
    const md = await searchViaJinaReader(query);
    console.log('[SearchService] ✅ Bing (via Jina Reader) 真实检索成功');
    return `【🌐 真实网络搜索结果 (Bing via Jina Reader)】针对 "${query}"：\n${md}`;
  } catch (e) {
    console.warn('[SearchService] Bing/Jina 检索失败:', e.message);
  }

  // 3. 最终兜底（仅在所有真实通道都失败时）
  return getFallbackSearchData(query);
}

// ── 真实图片检索：Wikimedia Commons API ─────────────────────────────────
async function searchWikimediaCommons(query) {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: query.substring(0, 80),
    gsrlimit: '6',
    gsrnamespace: '6',
    prop: 'imageinfo',
    iiprop: 'url',
    iiurlwidth: '800',
    format: 'json',
    origin: '*'
  });
  const resp = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
    signal: AbortSignal.timeout(12000)
  });
  if (!resp.ok) throw new Error(`Commons HTTP ${resp.status}`);
  const data = await resp.json();
  const pages = data?.query?.pages || {};
  return Object.values(pages)
    .map(p => ({
      title: p.title || 'image',
      url: p.imageinfo?.[0]?.thumburl || p.imageinfo?.[0]?.url || ''
    }))
    .filter(p => p.url);
}

/**
 * 高精图片资源检索：优先真实检索 Wikimedia Commons，失败回退内置素材库
 * @param {string} query 项目主题关键词
 */
export async function searchImageAssets(query) {
  try {
    const results = await searchWikimediaCommons(query);
    if (results.length > 0) {
      console.log(`[SearchService] ✅ Wikimedia Commons 真实图片检索成功 (${results.length} 张)`);
      return `🎨 【项目专属高精图片资源库 (真实检索结果 - Wikimedia Commons)】:
以下是针对项目主题真实检索到的免费可商用图片，请通过 <img src="..."> 或 CSS background-image: url(...) 调用，并为每个 img 添加 onerror 保底防破图:
${results.map((r, i) => `${i + 1}. ${r.title}: ${r.url}`).join('\n')}`;
    }
  } catch (e) {
    console.warn('[SearchService] 真实图片检索失败，回退内置素材库:', e.message);
  }
  return getStaticAssetRegistry(query);
}

// ── 内置高精图片素材库（离线保底） ──────────────────────────────────────
function getStaticAssetRegistry(query) {
  const assets = {
    backgrounds: [
      'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1550745165-9bc0b252726f?auto=format&fit=crop&w=1200&q=80'
    ],
    portraits: [
      'https://api.dicebear.com/7.x/bottts/svg?seed=hero_dog',
      'https://api.dicebear.com/7.x/adventurer/svg?seed=hero_master',
      'https://api.dicebear.com/7.x/avataaars/svg?seed=bilibili_up',
      'https://api.dicebear.com/7.x/big-smile/svg?seed=funny_meme',
      'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=400&q=80'
    ],
    gameElements: [
      'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=600&q=80',
      'https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?auto=format&fit=crop&w=600&q=80',
      'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?auto=format&fit=crop&w=800&q=80'
    ]
  };

  return `🎨 【项目内置高精图片素材库 (离线保底)】:
以下是系统内置的高清无版权网络图床链接，请在 HTML 中直接通过 <img src="..."> 或 CSS background-image: url(...) 调用：
- 🌆 【游戏/页面高精背景图库】:
  1. 赛博/炫彩背景: ${assets.backgrounds[0]}
  2. 电竞/暗黑背景: ${assets.backgrounds[1]}
  3. 梦幻夜空背景: ${assets.backgrounds[2]}
- 👤 【主角与二次元/热梗立绘库】:
  1. 萌宠/大狗立绘 (DiceBear): ${assets.portraits[0]}
  2. 勇者/主角立绘 (Adventurer): ${assets.portraits[1]}
  3. UP主/玩家立绘 (Avataaars): ${assets.portraits[2]}
  4. 搞笑热梗立绘 (BigSmile): ${assets.portraits[3]}
- 💎 【UI 道具与宣传插画库】:
  1. 道具/水晶关卡元素: ${assets.gameElements[0]}
  2. 动漫关卡场景插画: ${assets.gameElements[1]}
  3. 炫彩渐变 UI 装饰: ${assets.gameElements[2]}`;
}

// ── 最终兜底（真实通道全部失败） ────────────────────────────────────────
function getFallbackSearchData(query) {
  return `【⚠️ 联网检索暂不可用提示】
当前所有真实网络检索通道（DuckDuckGo / Bing via Jina Reader）暂时不可用，以下为基于内部知识库的推断建议（可能不包含最新信息）：
- 关于 "${query}" 的开发建议：推荐采用纯 H5 Canvas + CSS3 微特效架构，无缝兼容桌面与移动端。
- 如需最新资讯，请稍后重试开启联网检索。`;
}
