// Dynamic profile card — serves the terminal SVG with live GitHub stats.
//
// Fetches dark_mode.svg / light_mode.svg from this repo (kept fresh by the
// daily GitHub Action, including the expensive Lines-of-Code numbers), then
// replaces the id-tagged stats with values fetched live on every request:
// uptime, repos, contributed, stars, commits, followers.
//
// Deploy on Vercel with env var GITHUB_TOKEN (a read-only PAT).
// Usage in README: /api/card?theme=dark or /api/card?theme=light

const USER_NAME = process.env.USER_NAME || 'Derrick-MUGISHA';
const RAW_BASE = `https://raw.githubusercontent.com/${USER_NAME}/${USER_NAME}/main`;

// same justify lengths as today.py / the SVG generator
const JUST = { age_data: 54, repo_data: 6, star_data: 19, commit_data: 22, follower_data: 16 };

function uptime(from) {
    const now = new Date();
    let y = now.getUTCFullYear() - from.getUTCFullYear();
    let m = now.getUTCMonth() - from.getUTCMonth();
    let d = now.getUTCDate() - from.getUTCDate();
    if (d < 0) {
        m--;
        d += new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).getUTCDate();
    }
    if (m < 0) { y--; m += 12; }
    const s = (n) => (n === 1 ? '' : 's');
    const cake = (m === 0 && d === 0) ? ' 🎂' : '';
    return `${y} year${s(y)}, ${m} month${s(m)}, ${d} day${s(d)}${cake}`;
}

// port of today.py's justify_format: swap the value and rebalance the dot leader
function justify(svg, id, value, length = 0) {
    const text = typeof value === 'number' ? value.toLocaleString('en-US') : String(value);
    svg = svg.replace(
        new RegExp(`(<tspan[^>]*id="${id}"[^>]*>)[^<]*(</tspan>)`),
        `$1${text}$2`
    );
    const just = Math.max(0, length - text.length);
    const dots = just <= 2 ? ['', ' ', '. '][just] : ' ' + '.'.repeat(just) + ' ';
    return svg.replace(
        new RegExp(`(<tspan[^>]*id="${id}_dots"[^>]*>)[^<]*(</tspan>)`),
        `$1${dots}$2`
    );
}

async function graphql(query, variables, token) {
    const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { authorization: `bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`GraphQL ${res.status}`);
    const json = await res.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data;
}

async function liveStats(token) {
    const query = `
    query($login: String!, $cursor: String) {
        user(login: $login) {
            createdAt
            followers { totalCount }
            owned: repositories(ownerAffiliations: [OWNER], first: 100, after: $cursor) {
                totalCount
                nodes { stargazerCount }
                pageInfo { endCursor hasNextPage }
            }
            all: repositories(ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) {
                totalCount
            }
        }
    }`;
    let cursor = null, stars = 0, user = null;
    do {
        const data = await graphql(query, { login: USER_NAME, cursor }, token);
        user = data.user;
        for (const n of user.owned.nodes) stars += n.stargazerCount;
        cursor = user.owned.pageInfo.hasNextPage ? user.owned.pageInfo.endCursor : null;
    } while (cursor);

    const search = await fetch(
        `https://api.github.com/search/commits?q=author:${USER_NAME}&per_page=1`,
        { headers: { authorization: `bearer ${token}`, accept: 'application/vnd.github+json' } }
    );
    const commits = search.ok ? (await search.json()).total_count : null;

    return {
        age: uptime(new Date(user.createdAt)),
        repos: user.owned.totalCount,
        contrib: user.all.totalCount,
        stars,
        followers: user.followers.totalCount,
        commits,
    };
}

module.exports = async function handler(req, res) {
    try {
        const theme = req.query.theme === 'light' ? 'light_mode' : 'dark_mode';
        const tplRes = await fetch(`${RAW_BASE}/${theme}.svg`);
        if (!tplRes.ok) throw new Error(`template fetch ${tplRes.status}`);
        let svg = await tplRes.text();

        // if the token is missing/rate-limited, fall back to the pipeline's SVG as-is
        try {
            const s = await liveStats(process.env.GITHUB_TOKEN);
            svg = justify(svg, 'age_data', s.age, JUST.age_data);
            svg = justify(svg, 'repo_data', s.repos, JUST.repo_data);
            svg = justify(svg, 'contrib_data', s.contrib);
            svg = justify(svg, 'star_data', s.stars, JUST.star_data);
            svg = justify(svg, 'follower_data', s.followers, JUST.follower_data);
            if (s.commits !== null) svg = justify(svg, 'commit_data', s.commits, JUST.commit_data);
        } catch (e) {
            console.error('live stats failed, serving pipeline SVG:', e.message);
        }

        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
        res.status(200).send(svg);
    } catch (e) {
        res.status(502).send(`<!-- card error: ${e.message} -->`);
    }
};
