export const name = "shenxiaotong-web-policy";
export const inject = ["web"];

const ALLOWED_DOMAINS = ["gov.cn", "gov.hk", "gov.mo"];
const SEARCH_SUFFIX = "(site:gov.cn OR site:gov.hk OR site:gov.mo)";

function isAllowedOfficialUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return ["http:", "https:"].includes(url.protocol)
      && !url.username
      && !url.password
      && ALLOWED_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export function apply(ctx) {
  const web = ctx.web;
  const originalSearch = web.search.bind(web);
  const originalFetch = web.fetch.bind(web);
  const guardedSearch = async (request, signal) => {
    const result = await originalSearch({
      ...request,
      query: `${request.query} ${SEARCH_SUFFIX}`,
    }, signal);
    const safeResult = { ...result };
    delete safeResult.content;
    safeResult.sources = (Array.isArray(result.sources) ? result.sources : [])
      .filter((source) => isAllowedOfficialUrl(source?.url));
    return safeResult;
  };
  const guardedFetch = async (request, signal) => {
    if (!isAllowedOfficialUrl(request.url)) {
      throw new Error("该 URL 不在官方政务域名白名单内");
    }
    const result = await originalFetch(request, signal);
    if (!isAllowedOfficialUrl(result.url)) {
      throw new Error("抓取后的 URL 不在官方政务域名白名单内");
    }
    return result;
  };

  // shortcut: native search runs server-side; this filters returned sources, while an allowlist-aware provider must constrain backend retrieval.
  ctx.effect(() => {
    web.search = guardedSearch;
    web.fetch = guardedFetch;
    return () => {
      if (web.search === guardedSearch) delete web.search;
      if (web.fetch === guardedFetch) delete web.fetch;
    };
  }, "shenxiaotong: official web domain policy");
}
