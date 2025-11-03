const API_URL = window.location.origin; // mesma origem do backend
let currentUser = null;
let transactionsChart = null;

// Utilitário para formatar valores em R$
function formatCurrency(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(value);
}

// Mostrar alertas Bootstrap
function showAlert(message, type = 'success') {
  const alert = document.createElement('div');
  alert.className = `alert alert-${type} mt-3`;
  alert.textContent = message;
  document.querySelector('.container').prepend(alert);
  setTimeout(() => alert.remove(), 4000);
}

/* ===========================
   CADASTRO
=========================== */
document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const email = document.getElementById('registerEmail').value.trim();
  const password = document.getElementById('registerPassword').value.trim();
  const cpf = document.getElementById('cpf').value.trim();

  if (!/^\d{11}$/.test(cpf)) {
    showAlert('CPF inválido. Digite apenas números (11 dígitos).', 'danger');
    return;
  }

  try {
    const res = await fetch(`${API_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password, cpf })
    });
    const data = await res.json();
    if (data.userId) {
      showAlert('Cadastro realizado com sucesso! Agora faça login.', 'success');
      // Troca para aba de login
      document.querySelector('#login-tab').click();
    } else {
      showAlert(data.error || 'Erro no cadastro', 'danger');
    }
  } catch (err) {
    showAlert('Falha na conexão com o servidor', 'danger');
  }
});

/* ===========================
   LOGIN
=========================== */
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value.trim();

  try {
    const res = await fetch(`${API_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (data.userId) {
      currentUser = data;
      document.getElementById('dashboard').classList.remove('d-none');
      showAlert(`Bem-vindo, ${data.username || data.email}!`, 'success');
      loadWallet();
      loadTransactions();
    } else {
      showAlert(data.error || 'Credenciais inválidas', 'danger');
    }
  } catch (err) {
    showAlert('Falha na conexão com o servidor', 'danger');
  }
});

/* ===========================
   CARTEIRA
=========================== */
async function loadWallet() {
  if (!currentUser) return;
  const res = await fetch(`${API_URL}/wallet/${currentUser.userId}`);
  const data = await res.json();
  document.getElementById('balance').textContent = formatCurrency(data.balance);
  document.getElementById('hold').textContent = formatCurrency(data.hold);
}

/* ===========================
   DEPÓSITO
=========================== */
document.getElementById('depositForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser) return;

  const amount = parseFloat(document.getElementById('depositAmount').value);
  const buyer_document = document.getElementById('buyerDocument').value.trim();

  if (isNaN(amount) || amount <= 0) {
    showAlert('Digite um valor válido para depósito', 'danger');
    return;
  }
  if (!/^\d{11}$/.test(buyer_document)) {
    showAlert('Digite um CPF válido (11 dígitos)', 'danger');
    return;
  }

  try {
    const res = await fetch(`${API_URL}/deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: currentUser.email,
        amount,
        buyer_document
      })
    });
    const data = await res.json();
    if (data.id) {
      showAlert('Depósito iniciado com sucesso!', 'success');
      loadWallet();
      loadTransactions();
    } else {
      showAlert(data.error || 'Erro ao depositar', 'danger');
    }
  } catch (err) {
    showAlert('Falha na conexão com o servidor', 'danger');
  }
});

/* ===========================
   SAQUE
=========================== */
document.getElementById('payoutForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser) return;

  const amount = parseFloat(document.getElementById('payoutAmount').value);
  const destination = document.getElementById('destination').value.trim();

  if (isNaN(amount) || amount <= 0) {
    showAlert('Digite um valor válido para saque', 'danger');
    return;
  }
  if (!destination) {
    showAlert('Informe a chave PIX ou destino do saque', 'danger');
    return;
  }

  try {
    const res = await fetch(`${API_URL}/payout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: currentUser.email,
        amount,
        destination
      })
    });
    const data = await res.json();
    if (data.id) {
      showAlert('Saque solicitado com sucesso!', 'success');
      loadWallet();
      loadTransactions();
    } else {
      showAlert(data.error || 'Erro ao sacar', 'danger');
    }
  } catch (err) {
    showAlert('Falha na conexão com o servidor', 'danger');
  }
});

/* ===========================
   HISTÓRICO + GRÁFICO
=========================== */
function updateChart(transactions) {
  const ctx = document.getElementById('transactionsChart').getContext('2d');

  const labels = transactions.map(tx => new Date(tx.created_at).toLocaleDateString('pt-BR'));
  const values = transactions.map(tx => tx.amount);
  const colors = transactions.map(tx => tx.type === 'deposit' ? 'rgba(40,167,69,0.7)' : 'rgba(220,53,69,0.7)');

  if (transactionsChart) {
    transactionsChart.destroy();
  }

  transactionsChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Valor (R$)',
        data: values,
        backgroundColor: colors,
        borderColor: colors.map(c => c.replace('0.7', '1')),
        borderWidth: 1
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => formatCurrency(context.raw)
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: (value) => formatCurrency(value)
          }
        }
      }
    }
  });
}

async function loadTransactions() {
  if (!currentUser) return;
  const res = await fetch(`${API_URL}/transactions/${currentUser.userId}?limit=10`);
  const data = await res.json();
  const list = document.getElementById('transactions');
  list.innerHTML = '';

  data.items.forEach(tx => {
    const li = document.createElement('li');
    li.className = 'list-group-item bg-dark text-light border-secondary d-flex justify-content-between align-items-center';
    li.innerHTML = `
      <span>${tx.type === 'deposit' ? '💰 Depósito' : '💸 Saque'} - ${formatCurrency(tx.amount)}</span>
      <span class="badge bg-${tx.status === 'succeeded' ? 'success' : tx.status === 'pending' ? 'warning' : 'secondary'}">
        ${tx.status}
      </span>
    `;
    list.appendChild(li);
  });

  // Atualizar gráfico em ordem cronológica
  updateChart(data.items.reverse());
        }
