/* 한양빌딩 하자관리 · 독립 사이트용 저장소 연결 (Supabase)
   claude.ai 아티팩트에서 쓰던 window.claude.use('db' | 'user' | 'assets' | 'downloads') 와 같은 모양의 객체를 Supabase로 만들어 줍니다.
   index.html은 claude.ai 판과 같은 파일을 그대로 씁니다. config.js에 Supabase 주소·키가 있을 때만 이 연결이 켜집니다.

   데이터 구조 (supabase/schema.sql)
   - docs(path, collection, data, updated_at) : members/{eid}, defects/{HJ-id}, inspections/{key}, details/{key}
   - 읽기는 누구나, 쓰기는 app_admins 표에 등록된 관리자 계정만 (RLS)
   - hj_acquire(): 하자 ID 확보용 짧은 잠금
   - Storage 버킷 hj-photos: 보수 전·후 사진, 상세도 파일 (읽기 공개, 올리기 관리자) */
(function () {
  const cfg = window.HJ_CONFIG || {};
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return;          // 설정이 없으면 아무것도 하지 않음 (claude.ai 판과 동일하게 동작)
  if (/YOUR-PROJECT|YOUR-ANON-KEY/.test(cfg.supabaseUrl + cfg.supabaseAnonKey)) {   // 아직 설정 전
    window.HJ_AUTH = { mode: 'supabase', missing: true, hasSession: () => false, signIn: async () => { throw new Error('config'); }, signOut: async () => {} };
    window.claude = { use: async () => null }; return;
  }
  const ref = (/^https:\/\/([a-z0-9-]+)\./.exec(cfg.supabaseUrl) || [])[1] || 'local';
  const TOKEN_KEY = `sb-${ref}-auth-token`;
  const BUCKET = cfg.bucket || 'hj-photos';
  let resolveReady; const ready = new Promise(r => { resolveReady = r; });
  let sb = null;

  /* ---- 로그인 (index.html이 동기적으로 확인할 수 있도록 먼저 만들어 둠) ---- */
  window.HJ_AUTH = {
    mode: 'supabase',
    hasSession() { try { const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); return !!(t && t.access_token); } catch { return false; } },
    async signIn(password) {
      await ready;
      const { error } = await sb.auth.signInWithPassword({ email: cfg.adminEmail, password });
      if (error) throw error;
    },
    async signOut() { await ready; await sb.auth.signOut(); }
  };
  window.HJ_BLOB = id => /^https?:/.test(id) ? id : `${cfg.supabaseUrl}/storage/v1/object/public/${BUCKET}/${String(id).split('/').map(encodeURIComponent).join('/')}`;

  /* ---- 오류 코드를 사이트가 이해하는 코드로 ---- */
  const errOf = e => {
    const m = String((e && (e.message || e.error_description)) || e || '');
    if (e && (e.code === '42501' || /row-level security|permission|not authorized|JWT/i.test(m))) return { code: 'invalid_argument', message: m };
    if (e && e.code === 'PGRST116') return { code: 'invalid_argument', message: m };
    if (/payload|too large|413/i.test(m)) return { code: 'too_large', message: m };
    return { code: 'unavailable', message: m };
  };

  /* ---- 컬렉션 캐시 + 실시간 반영 ---- */
  const cols = new Map();   // name -> { docs: Map(id -> data), subs: Set, loaded, loading }
  const colOf = name => { if (!cols.has(name)) cols.set(name, { docs: new Map(), subs: new Set(), loaded: false, loading: null }); return cols.get(name); };
  const idOf = path => path.split('/').slice(-1)[0];
  const colName = path => path.split('/').slice(0, -1).join('/');
  const frozen = o => Object.freeze(JSON.parse(JSON.stringify(o)));
  const snapOf = c => {
    const docs = [...c.docs.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([id, data]) => ({ id, exists: true, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } }));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: !c.loaded, hasPendingWrites: false } };
  };
  const notify = name => { const c = colOf(name); c.subs.forEach(s => { try { s.next(snapOf(c)); } catch (e) { console.error(e); } }); };
  async function load(name) {
    const c = colOf(name);
    if (!c.loading) c.loading = (async () => {
      await ready;
      const all = []; let from = 0;
      for (;;) {                                        // 1000행씩 나눠 읽기
        const { data, error } = await sb.from('docs').select('path,data').eq('collection', name).range(from, from + 999);
        if (error) throw errOf(error);
        all.push(...data); if (data.length < 1000) break; from += 1000;
      }
      c.docs = new Map(all.map(r => [idOf(r.path), frozen(r.data)])); c.loaded = true; notify(name);
    })().catch(e => { c.loading = null; c.subs.forEach(s => s.error && s.error(e.code ? e : errOf(e))); });
    return c.loading;
  }
  function applyRow(row, deleted) {
    if (!row || !row.path) return;
    const name = row.collection || colName(row.path); if (!cols.has(name)) return;
    const c = cols.get(name);
    if (deleted) c.docs.delete(idOf(row.path)); else c.docs.set(idOf(row.path), frozen(row.data));
    notify(name);
  }

  /* ---- 문서 참조 ---- */
  function doc(path) {
    const id = idOf(path), name = colName(path);
    return {
      id, path,
      async get() { await ready; const { data, error } = await sb.from('docs').select('data').eq('path', path).maybeSingle(); if (error) throw errOf(error); return { id, exists: !!data, data: () => data ? frozen(data.data) : undefined, metadata: { fromCache: false, hasPendingWrites: false } }; },
      async set(v) {
        await ready; const body = JSON.parse(JSON.stringify(v));
        const { error } = await sb.from('docs').upsert({ path, collection: name, data: body, updated_at: new Date().toISOString() });
        if (error) throw errOf(error); applyRow({ path, collection: name, data: body });
      },
      async update(v) {
        await ready;
        const { data, error } = await sb.from('docs').select('data').eq('path', path).maybeSingle();
        if (error) throw errOf(error); if (!data) throw { code: 'invalid_argument', message: 'document does not exist' };
        const merge = (a, b) => { const o = { ...a }; for (const [k, x] of Object.entries(b)) o[k] = x && typeof x === 'object' && !Array.isArray(x) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? merge(a[k], x) : x; return o; };
        const body = merge(data.data, JSON.parse(JSON.stringify(v)));
        const r = await sb.from('docs').update({ data: body, updated_at: new Date().toISOString() }).eq('path', path).select('path');
        if (r.error) throw errOf(r.error); if (!r.data || !r.data.length) throw { code: 'invalid_argument', message: 'not permitted' };
        applyRow({ path, collection: name, data: body });
      },
      async delete() { await ready; const { error } = await sb.from('docs').delete().eq('path', path); if (error) throw errOf(error); applyRow({ path, collection: name }, true); },
      async acquire({ holder, ttlMs }) {
        await ready; const { data, error } = await sb.rpc('hj_acquire', { p_path: path, p_holder: String(holder), p_ttl_ms: ttlMs || 30000 });
        if (error) throw errOf(error); return { acquired: !!(data && data.acquired), expiresAt: data && data.expiresAt, holder: data && data.acquired ? holder : undefined };
      },
      onSnapshot(next, error) { const c = colOf(name); const s = { next: () => next(this.getCached()), error }; c.subs.add(s); load(name); return () => c.subs.delete(s); },
      getCached() { const c = colOf(name); const d = c.docs.get(id); return { id, exists: !!d, data: () => d, metadata: { fromCache: !c.loaded, hasPendingWrites: false } }; },
      collection(sub) { return collection(path + '/' + sub); }
    };
  }
  function collection(name) {
    return {
      path: name,
      doc: id => doc(name + '/' + (id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)))),
      async add(v) { const d = doc(name + '/' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)); await d.set(v); return d; },
      onSnapshot(next, error) { const c = colOf(name); const s = { next, error }; c.subs.add(s); if (c.loaded) next(snapOf(c)); else load(name); return () => c.subs.delete(s); },
      async get() { await load(name); return snapOf(colOf(name)); }
    };
  }
  const db = { doc, collection };

  /* ---- 사용자 ---- */
  const localId = (() => { try { let v = localStorage.getItem('hj-local-id'); if (!v) { v = 'b_' + Math.random().toString(36).slice(2, 12); localStorage.setItem('hj-local-id', v); } return v; } catch { return 'b_anon'; } })();
  const user = {
    async id() { await ready; const { data } = await sb.auth.getSession(); return data.session ? data.session.user.id : localId; },
    async can(what) {
      await ready; const { data } = await sb.auth.getSession(); if (!data.session) return false;
      const r = await sb.rpc('hj_is_admin'); return r.error ? null : !!r.data;      // 관리자 표에 있는 계정만 쓰기 가능
    },
    async profiles(ids) { await ready; const { data } = await sb.auth.getSession(); const me = data.session && data.session.user.id; return Object.fromEntries(ids.map(i => [i, { name: i === me ? '관리자' : (String(i).startsWith('u_') ? 'claude.ai 사용자' : '관리자') }])); }
  };

  /* ---- 사진·파일 ---- */
  const assets = {
    async upload(file, opt = {}) {
      await ready;
      const ext = (/\.([a-z0-9]+)$/i.exec(file.name || '') || [, 'bin'])[1].toLowerCase();
      const key = `${new Date().toISOString().slice(0, 10)}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      if (file.size > 20 * 1024 * 1024) throw { code: 'too_large' };
      const { error } = await sb.storage.from(BUCKET).upload(key, file, { contentType: opt.type || file.type || 'application/octet-stream', upsert: false });
      if (error) throw errOf(error);
      return { id: key, url: window.HJ_BLOB(key), sizeBytes: file.size };
    }
  };

  /* ---- 내려받기 ---- */
  const downloads = {
    async save({ filename, data }) {
      const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
      const a = document.createElement('a'); a.href = url; a.download = filename || 'download'; document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 1000);
      setTimeout(() => URL.revokeObjectURL(url), 4000); return { status: 'saved' };
    }
  };

  window.claude = { use: async n => { await ready; return ({ db, user, assets, downloads })[n] || null; } };

  /* ---- supabase-js 불러오기 + 실시간 구독 ---- */
  import(cfg.supabaseJs || 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm').then(m => {
    sb = m.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, storageKey: TOKEN_KEY } });
    sb.channel('hj-docs').on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, p => {
      if (p.eventType === 'DELETE') applyRow(p.old, true); else applyRow(p.new);
    }).subscribe();
    resolveReady();
  }).catch(e => { console.error('supabase-js load failed', e); window.claude = { use: async () => null }; });
})();
