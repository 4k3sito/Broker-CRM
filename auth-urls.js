// Un único origen para los flujos de autenticación. En desarrollo conserva el
// host/puerto actual; en producción usa el dominio público del CRM.
(function configureAuthUrls() {
  const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const appOrigin = isLocal ? window.location.origin : 'https://4k3sito.github.io';
  const at = path => new URL(path, `${appOrigin}/`).href;

  window.officeTrackerUrls = Object.freeze({
    dashboard: at('index.html'),
    login: at('login.html'),
    resetPassword: at('reset-password.html'),
    updatePassword: at('update-password.html'),
  });
})();
