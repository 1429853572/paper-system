/* 登录/注册页逻辑（原内联脚本外置）。
 * 外置原因：CSP 用 script-src-elem 'self' 禁止内联 <script> 块（防注入），
 * 只保留 script-src-attr 'unsafe-inline' 放行 index.html/viewer.js 的 onclick 属性。 */
(function () {
  const $ = (s) => document.querySelector(s);

  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.pane').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      $('#' + t.dataset.tab + '-form').classList.add('active');
    };
  });

  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username: f.get('username'), password: f.get('password')}),
    });
    if (r.ok) {
      location.href = '/';
    } else {
      $('#login-err').textContent = (await r.json()).detail || '登录失败';
    }
  };

  $('#register-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (f.get('password') !== f.get('password2')) {
      $('#reg-err').textContent = '两次密码不一致';
      return;
    }
    const r = await fetch('/api/register', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        invite_code: f.get('invite_code'),
        username: f.get('username'),
        password: f.get('password'),
      }),
    });
    if (r.ok) {
      location.href = '/';
    } else {
      $('#reg-err').textContent = (await r.json()).detail || '注册失败';
    }
  };

  // 已登录直接进
  fetch('/api/me').then((r) => {
    if (r.ok) location.href = '/';
  });
})();
