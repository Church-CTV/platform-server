/**
 * LAN restriction for the operator surfaces (self-host exposure).
 *
 * Two things were wrong with this file when the admin design was written up (2026-11-08,
 * the private admin-studio design record section 3, open item in the private record t8-admin-groundwork-2026-11-08
 * section 6): it was mounted nowhere, and its IPv6 branch returned `next()` unconditionally, so any IPv6
 * client reached the admin panel whatever `ALLOWED_NETWORKS` said. A dual-stack home router makes that the
 * normal case, not the exotic one. A third, smaller one: a request with no identifiable peer address threw a
 * TypeError inside the middleware, which Express turns into a 500.
 *
 * Contract now, in the fail-closed spirit of `../CONFIGURATION.md`:
 *  - opt-in: with no `ALLOWED_NETWORKS` set, the middleware allows (an operator must not be locked out of
 *    their own box by a variable they never set);
 *  - a peer we cannot identify is refused (`peer-address-unknown`), never waved through;
 *  - a peer is matched against the configured networks **of its own family**; an IPv6 peer when only IPv4
 *    networks are configured is refused, because "LAN only" cannot be evaluated for a family the
 *    allow-list does not name;
 *  - every refusal is machine-readable: `X-CTV-Denied` on the response, and `{error, reason, peer,
 *    networks}` for JSON clients, so the alert router and the operator screen quote the same fact;
 *  - a malformed entry is skipped with a warning and grants nothing (a typo must not open the box).
 */

const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;

function parseIpv4(text) {
    const parts = String(text).trim().split('.');
    if (parts.length !== 4) return null;
    const bytes = [];
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const value = Number(part);
        if (value > 255) return null;
        bytes.push(value);
    }
    return { family: 4, bytes, text: parts.join('.') };
}

function parseIpv6(text) {
    let value = String(text).trim().split('%')[0]; // a zone id names the link, not the address
    const lastColon = value.lastIndexOf(':');
    const tail = value.slice(lastColon + 1);
    if (tail.includes('.')) {
        // IPv4-mapped or IPv4-compatible form: ::ffff:192.0.2.1
        const embedded = parseIpv4(tail);
        if (!embedded) return null;
        const hi = (embedded.bytes[0] << 8) | embedded.bytes[1];
        const lo = (embedded.bytes[2] << 8) | embedded.bytes[3];
        value = `${value.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
    }
    const compression = value.indexOf('::');
    if (compression !== -1 && value.indexOf('::', compression + 1) !== -1) return null;
    let left;
    let right;
    if (compression === -1) {
        left = value.split(':');
        right = [];
    } else {
        const head = value.slice(0, compression);
        const rest = value.slice(compression + 2);
        left = head === '' ? [] : head.split(':');
        right = rest === '' ? [] : rest.split(':');
    }
    const groups = [];
    for (const group of left.concat(right)) {
        if (!HEX_GROUP.test(group)) return null;
        groups.push(parseInt(group, 16));
    }
    if (compression === -1) {
        if (groups.length !== 8) return null;
    } else if (groups.length > 7) {
        // `::` has to stand for at least one zero group.
        return null;
    }
    const padded = [];
    if (compression === -1) {
        padded.push(...groups);
    } else {
        const headGroups = left.map((group) => parseInt(group, 16));
        const tailGroups = right.map((group) => parseInt(group, 16));
        padded.push(...headGroups);
        for (let i = padded.length + tailGroups.length; i < 8; i += 1) padded.push(0);
        padded.push(...tailGroups);
    }
    if (padded.length !== 8) return null;
    const bytes = [];
    for (const group of padded) {
        bytes.push((group >> 8) & 0xff, group & 0xff);
    }
    return { family: 6, bytes, text: value };
}

function parseAddress(text) {
    if (typeof text !== 'string' || text.trim() === '') return null;
    let candidate = text.trim();
    if (candidate.startsWith('::ffff:') && candidate.slice(7).includes('.')) {
        // A dual-stack socket reports an IPv4 peer this way; it is the same address the operator typed.
        return parseIpv4(candidate.slice(7));
    }
    if (candidate.includes(':')) return parseIpv6(candidate);
    return parseIpv4(candidate);
}

function parseNetwork(entry) {
    const [prefix, bitsText] = String(entry).trim().split('/');
    if (!prefix) return null;
    const address = prefix.includes(':') ? parseIpv6(prefix) : parseIpv4(prefix);
    if (!address) return null;
    if (bitsText === undefined) return null; // a bare address grants nothing; the prefix is the policy
    if (!/^\d{1,3}$/.test(bitsText)) return null;
    const bits = Number(bitsText);
    const max = address.family === 4 ? 32 : 128;
    if (bits > max) return null;
    return { family: address.family, bytes: address.bytes, bits, text: String(entry).trim() };
}

function inNetwork(network, address) {
    if (network.family !== address.family) return false;
    for (let i = 0; i < network.bytes.length; i += 1) {
        const significant = Math.min(8, Math.max(0, network.bits - i * 8));
        if (significant === 0) break;
        const mask = (0xff << (8 - significant)) & 0xff;
        if ((network.bytes[i] & mask) !== (address.bytes[i] & mask)) return false;
    }
    return true;
}

/**
 * One policy, one implementation: answer whether a peer address may use an operator surface under an
 * `ALLOWED_NETWORKS` list. `lanRestrict` below is the HTTP gate; `middleware/adminAuth.js` asks the same
 * question when it decides between "not signed in" and "not on the LAN", and until 2026-11-08 it answered
 * it with a second, IPv4-only copy of the matcher that kept its own IPv6 bypass.
 */
function peerAllowed(peerText, allowListText) {
    const configured = String(allowListText || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    const networks = [];
    for (const entry of configured) {
        const parsed = parseNetwork(entry);
        if (!parsed) {
            console.warn(`LAN restrict: ignoring malformed network "${entry}" - use "192.168.1.0/24" or "fd00::/8".`);
            continue;
        }
        networks.push(parsed);
    }
    const names = networks.map((network) => network.text);
    const peer = parseAddress(peerText);
    if (!peer) return { allowed: false, reason: 'peer-address-unknown', peer: peerText || null, networks: names };
    // Fail closed on a family the allow-list does not speak about: "LAN only" is not decidable for an IPv6
    // peer when every configured network is IPv4, and until 2026-11-08 both copies of this check let it pass.
    const sameFamily = networks.filter((network) => network.family === peer.family);
    if (sameFamily.length === 0)
        return { allowed: false, reason: 'address-not-allowed', peer: peer.text, networks: names };
    if (sameFamily.some((network) => inNetwork(network, peer))) {
        return { allowed: true, reason: 'address-allowed', peer: peer.text, networks: names };
    }
    return { allowed: false, reason: 'address-not-allowed', peer: peer.text, networks: names };
}

function deny(req, res, { reason, peer, networks }) {
    res.set('X-CTV-Denied', reason);
    const wantsJson =
        req.xhr ||
        (req.headers && typeof req.headers.accept === 'string' && req.headers.accept.includes('application/json'));
    if (wantsJson) return res.status(403).json({ error: 'lan-restricted', reason, peer, networks });
    return res.status(403).send(`Access denied: only the configured LAN may reach this panel (${reason}).`);
}

function lanRestrict(req, res, next) {
    const allowed = process.env.ALLOWED_NETWORKS;
    if (!allowed) return next(); // opt-in: an operator must not be locked out by a variable they never set
    const peerText = req.ip || (req.connection && req.connection.remoteAddress);
    const decision = peerAllowed(peerText, allowed);
    if (decision.allowed) return next();
    return deny(req, res, decision);
}

module.exports = { lanRestrict, peerAllowed, parseAddress, parseNetwork, inNetwork };
