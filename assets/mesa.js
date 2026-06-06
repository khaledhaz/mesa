/* ============================================================================
   Mesa — shared runtime (config + Supabase client + helpers)
   Load AFTER the supabase-js UMD bundle. Exposes window.MESA.
   Usage in HTML:
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="assets/mesa.js"></script>
   ============================================================================ */
(function () {
  var CFG = {
    SUPABASE_URL: 'https://durugcxsakdbgimgkyiw.supabase.co',
    SUPABASE_KEY: 'sb_publishable_rfZYlRhgpU23UJHox-tpHw_142Q3U2V',
    DEMO_OWNER_EMAIL: 'demo@mesa.app',
    DEMO_TABLE_CODES: ['OE-03', 'OE-05'],
  };

  var sb = null;
  if (window.supabase && window.supabase.createClient) {
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'mesa-auth' },
    });
  } else {
    console.error('[mesa] supabase-js not loaded before mesa.js');
  }

  // ---- money ----
  var CUR = { USD: '$', GBP: '£', EUR: '€', AED: 'AED ', SAR: 'SAR ' };
  function money(cents, currency) {
    var sym = CUR[currency || 'USD'] || (currency ? currency + ' ' : '$');
    var v = (Number(cents || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return sym + v;
  }
  function dollars(cents) { return (Number(cents || 0) / 100); }

  // ---- dom helpers ----
  function el(sel, root) { return (root || document).querySelector(sel); }
  function els(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function h(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    });
    if (children != null) (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c == null) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ---- toast ----
  function toast(msg, kind, ms) {
    var host = el('#mesa-toast');
    if (!host) { host = h('div', { id: 'mesa-toast' }); document.body.appendChild(host); }
    var t = h('div', { class: 'mesa-toast ' + (kind || ''), text: msg });
    host.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .25s'; t.style.opacity = '0';
      setTimeout(function () { t.remove(); }, 260); }, ms || 2600);
  }

  // ---- white-label brand application ----
  // Returns the (possibly fallback) accent actually applied.
  function relLum(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return 1;
    var c = [m[1], m[2], m[3]].map(function (x) {
      var v = parseInt(x, 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrastWithWhite(hex) { var L = relLum(hex); return 1.05 / (L + 0.05); }
  function applyBrand(accentHex) {
    var root = document.documentElement, fallback = '#C4522A', used = accentHex;
    if (!accentHex || contrastWithWhite(accentHex) < 4.5) used = fallback; // a11y guard
    root.style.setProperty('--color-restaurant-accent', used);
    // white foreground works for all sufficiently-dark accents; else dark ink
    root.style.setProperty('--color-restaurant-accent-foreground', contrastWithWhite(used) >= 4.5 ? '#FFFFFF' : '#1A1208');
    return used;
  }

  // ---- query helpers (anon diner flow) ----
  // Load a full table session by table_code: brand + session + items + server name + menu.
  async function loadTableBill(code) {
    var rTable = await sb.from('mesa_tables').select('id,restaurant_id,label,table_code,seats').eq('table_code', code).maybeSingle();
    if (rTable.error) throw rTable.error;
    if (!rTable.data) return { notFound: true };
    var table = rTable.data;
    var rRest = await sb.from('mesa_restaurants')
      .select('id,name,slug,brand_logo_url,brand_primary,brand_accent,currency,service_charge_pct,tip_presets')
      .eq('id', table.restaurant_id).maybeSingle();
    if (rRest.error) throw rRest.error;
    var rest = rRest.data;
    var rSess = await sb.from('mesa_sessions')
      .select('id,status,party_size,server_staff_id,opened_at')
      .eq('table_id', table.id).neq('status', 'closed').order('opened_at', { ascending: false }).limit(1).maybeSingle();
    if (rSess.error) throw rSess.error;
    var session = rSess.data;
    var items = [], server = null;
    if (session) {
      var rItems = await sb.from('mesa_order_items')
        .select('id,name,unit_price_cents,qty,claimed_by,menu_item_id')
        .eq('session_id', session.id).order('created_at', { ascending: true });
      if (rItems.error) throw rItems.error;
      items = rItems.data || [];
      if (session.server_staff_id) {
        var rSrv = await sb.from('mesa_staff').select('name').eq('id', session.server_staff_id).maybeSingle();
        server = rSrv.data ? rSrv.data.name : null;
      }
    }
    return { table: table, restaurant: rest, session: session, items: items, server: server };
  }

  function billMath(items, serviceChargePct) {
    var subtotal = (items || []).reduce(function (s, it) { return s + it.unit_price_cents * it.qty; }, 0);
    var service = Math.round(subtotal * (Number(serviceChargePct || 0) / 100));
    return { subtotal_cents: subtotal, service_cents: service, total_before_tip_cents: subtotal + service };
  }

  async function claimItem(itemId, label) {
    return sb.from('mesa_order_items').update({ claimed_by: label }).eq('id', itemId);
  }
  async function insertPayment(p) {
    // p: { session_id, restaurant_id, payer_label, amount_cents, tip_cents, service_charge_cents, method }
    var ins = await sb.from('mesa_payments').insert(Object.assign({ status: 'pending' }, p)).select('id').single();
    if (ins.error) return ins;
    return sb.from('mesa_payments').update({ status: 'succeeded' }).eq('id', ins.data.id).select('id').single();
  }
  async function joinLoyalty(restaurantId, phone, name) {
    return sb.from('mesa_loyalty_members').insert({ restaurant_id: restaurantId, phone: phone, name: name || null, points: 10, visits: 1, last_visit: new Date().toISOString() });
  }

  window.MESA = {
    cfg: CFG, sb: sb,
    money: money, dollars: dollars,
    el: el, els: els, h: h, esc: esc, toast: toast,
    applyBrand: applyBrand, contrastWithWhite: contrastWithWhite,
    loadTableBill: loadTableBill, billMath: billMath,
    claimItem: claimItem, insertPayment: insertPayment, joinLoyalty: joinLoyalty,
  };
})();
