const SUPABASE_URL = 'https://fbtyjwpeymnguetrcwzt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Ke4bAiGgcM6bMxaOk-u2Zw_S9AMSo1C';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const form = document.getElementById('resetForm');
const emailInput = document.getElementById('email');
const formError = document.getElementById('formError');
const submitButton = document.getElementById('submitButton');
const { updatePassword: updatePasswordUrl } = window.officeTrackerUrls;

form.addEventListener('submit', async event => {
  event.preventDefault();
  formError.hidden = true;
  if (!emailInput.checkValidity()) {
    formError.textContent = 'Ingresa un correo de trabajo válido.';
    formError.hidden = false;
    emailInput.focus();
    return;
  }

  submitButton.disabled = true;
  submitButton.querySelector('span').textContent = 'Enviando enlace…';
  const { error } = await db.auth.resetPasswordForEmail(emailInput.value.trim(), {
    redirectTo: updatePasswordUrl,
  });
  submitButton.disabled = false;
  submitButton.querySelector('span').textContent = 'Enviar enlace';

  if (error) {
    console.warn('No se pudo solicitar el restablecimiento:', error.message);
    formError.textContent = 'No fue posible solicitar el enlace. Inténtalo de nuevo.';
    formError.hidden = false;
    return;
  }

  document.getElementById('requestView').hidden = true;
  document.getElementById('successView').hidden = false;
});
