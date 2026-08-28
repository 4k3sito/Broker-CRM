// Cambio de contraseña. El endpoint exige la contraseña actual aunque ya haya
// sesión: una cookie robada no debe bastar para apoderarse de la cuenta.
const MIN_PASSWORD_LENGTH = 10;
const form = document.getElementById('updateForm');
const actualInput = document.getElementById('actual');
const passwordInput = document.getElementById('password');
const confirmationInput = document.getElementById('passwordConfirmation');
const submitButton = document.getElementById('submitButton');
const formError = document.getElementById('formError');
const updateView = document.getElementById('updateView');
const successView = document.getElementById('successView');

function showError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

function setLoading(loading) {
  submitButton.disabled = loading;
  submitButton.querySelector('span').textContent = loading ? 'Guardando…' : 'Guardar contraseña';
}

// Sin sesión no hay nada que cambiar; api.js redirige al login en el 401.
API.me().catch(() => {});

form.addEventListener('submit', async event => {
  event.preventDefault();
  formError.hidden = true;

  if (passwordInput.value.length < MIN_PASSWORD_LENGTH) {
    showError(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
    return passwordInput.focus();
  }
  if (passwordInput.value !== confirmationInput.value) {
    showError('Las contraseñas no coinciden.');
    return confirmationInput.focus();
  }

  setLoading(true);
  try {
    const r = await API.post('/password', {
      actual: actualInput.value,
      nueva: passwordInput.value,
    });
    updateView.hidden = true;
    successView.hidden = false;
    if (r.sesiones_cerradas) {
      successView.querySelector('p:last-of-type').textContent =
        `Tu nueva contraseña se guardó. Se cerraron ${r.sesiones_cerradas} sesión(es) abiertas en otros dispositivos.`;
    }
  } catch (err) {
    showError(err.message);
    setLoading(false);
  }
});
