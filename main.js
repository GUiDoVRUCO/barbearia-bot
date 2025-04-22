require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Client } = require('whatsapp-web.js');
const mongoose = require('mongoose');
const cron = require('node-cron');
const winston = require('winston');
const qrcode = require('qrcode');

// Configuração de logs com winston
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'bot.log' }),
    new winston.transports.Console()
  ]
});

// Conectar ao MongoDB Atlas
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => logger.info('Conectado ao MongoDB Atlas'))
  .catch(err => {
    logger.error(`Erro ao conectar ao MongoDB: ${err.message}`);
    process.exit(1);
  });

// Esquemas do MongoDB
const AgendamentoSchema = new mongoose.Schema({
  nome: String,
  data: String,
  hora: String,
  sender: String,
  timestamp: String
});
const FeedbackSchema = new mongoose.Schema({
  nome: String,
  comentario: String,
  avaliacao: Number,
  timestamp: String
});
const CancelamentoSchema = new mongoose.Schema({
  nome: String,
  data: String,
  hora: String,
  motivo: String,
  timestamp: String
});
const UserSchema = new mongoose.Schema({
  username: String,
  password: String
});

const Agendamento = mongoose.model('Agendamento', AgendamentoSchema);
const Feedback = mongoose.model('Feedback', FeedbackSchema);
const Cancelamento = mongoose.model('Cancelamento', CancelamentoSchema);
const User = mongoose.model('User', UserSchema);

// Inicializar Express
const app = express();
app.use(express.json());
app.use(express.static('public'));

// Configurações da barbearia
const ADMIN_PHONE = process.env.ADMIN_PHONE || '+5582993230395@c.us';
const INFO = {
  horario: "Seg a Sáb: 9h às 21h.",
  endereco: "Tv. Dona Alzira Aguiar - Pajuçara, Maceió - AL, 57030-680."
};
const ESTILOS = {
  "cabelo curto": { sugestao: "Corte Militar", barbeiro: "Chocolate", preco: 50 },
  "cabelo longo": { sugestao: "Corte Surfer", barbeiro: "Chocolate", preco: 60 },
  "barba cheia": { sugestao: "Barba Lenador", barbeiro: "Chocolate", preco: 40 },
  "barba rala": { sugestao: "Barba Desenhada", barbeiro: "Chocolate", preco: 35 },
  "degrade": { sugestao: "Degradê Navalhado", barbeiro: "Chocolate", preco: 55 }
};

// Estado por usuário
const estados = new Map();
const conversasChocolate = new Map();
const sessions = {};
let ultimoAgendamento = null;

// Funções auxiliares de validação
function validarHorario(horario) {
  const regex = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;
  return regex.test(horario);
}

function validarData(data) {
  const regex = /^(\d{2})\/(\d{2})\/(\d{4})$/;
  if (!regex.test(data)) return false;
  const [_, dia, mes, ano] = data.match(regex);
  const date = new Date(parseInt(ano), parseInt(mes) - 1, parseInt(dia));
  return date instanceof Date && !isNaN(date);
}

function getEstado(sender) {
  if (!estados.has(sender)) {
    estados.set(sender, { ultimoContato: Date.now() });
  }
  return estados.get(sender);
}

// Limpar estados inativos a cada 10 minutos
setInterval(() => {
  const agora = Date.now();
  for (const [sender, estado] of estados) {
    if (estado.ultimoContato && agora - estado.ultimoContato > 10 * 60 * 1000) {
      estados.delete(sender);
      logger.info(`Estado do usuário ${sender} limpo por inatividade.`);
    }
  }
}, 10 * 60 * 1000);

// Notificar administrador
async function notificarAdmin(client, mensagem) {
  try {
    await client.sendMessage(ADMIN_PHONE, mensagem);
    logger.info(`Notificação enviada ao admin: ${mensagem}`);
  } catch (err) {
    logger.error(`Erro ao notificar admin: ${err.message}`);
  }
}

// Funções do bot
function mostrarMenu() {
  return "E aí, qual é o plano? 😎\n" +
         "1. Agendar um corte 📝\n" +
         "2. Cancelar agendamento\n" +
         "3. Ver agendamentos\n" +
         "4. Horário da barbearia 🕛\n" +
         "5. Onde fica? 🌎\n" +
         "6. Papo com o Chocolate 🗣️\n" +
         "7. Sair";
}

function listarHorarios(sender) {
  const estado = getEstado(sender);
  estado.etapa = "data";
  return "Digite a data do agendamento (DD/MM/YYYY) ou 'sair' para voltar ao menu:";
}

async function listarAgendamentosDia(sender, data = null) {
  const hoje = data || new Date().toISOString().split('T')[0];
  const diaSemana = new Date(hoje).getDay();
  const [horaInicio, horaFim] = diaSemana === 6 ? [10, 16] : [9, 20];
  let horarios = [];
  let currentTime = new Date(`${hoje}T${horaInicio.toString().padStart(2, '0')}:00:00`);
  const fimTime = new Date(`${hoje}T${horaFim.toString().padStart(2, '0')}:00:00`);

  const rows = await Agendamento.find({ data: hoje });
  while (currentTime < fimTime) {
    const horaStr = currentTime.toTimeString().slice(0, 5);
    const agendado = rows.find(a => a.hora === horaStr);
    const isAdmin = sender === ADMIN_PHONE;
    const status = agendado
      ? `⏰ (agendado${isAdmin ? ` - ${agendado.nome}` : ''})`
      : "✅ (disponível)";
    horarios.push(`${horaStr} ${status}`);
    currentTime.setMinutes(currentTime.getMinutes() + 30);
  }
  return horarios.join("\n") + "\n\n" + mostrarMenu();
}

function triagemEstilo(estilo, nome) {
  estilo = estilo.toLowerCase();
  for (const [chave, info] of Object.entries(ESTILOS)) {
    if (estilo.includes(chave)) {
      return (`Sugerimos o *${info.sugestao}* com o barbeiro ${info.barbeiro} (R$${info.preco}). 😎 ` +
              `Deseja agendar? Digite 1 para iniciar.\n\n${mostrarMenu()}`);
    }
  }
  return "Estilo não identificado. Descreva novamente (ex.: cabelo curto, barba cheia).\n\n" + mostrarMenu();
}

async function agendarServico(nome, data, hora, sender, client) {
  try {
    if (!validarHorario(hora)) throw new Error("Horário inválido");
    const dataObj = new Date(data);
    const diaSemana = dataObj.getDay();
    const [horaInicio, horaFim] = diaSemana === 6 ? [10, 16] : [9, 20];
    const horaNum = parseInt(hora.split(":")[0]);
    if (horaNum < horaInicio || horaNum >= horaFim) {
      throw new Error(`Horário fora do expediente (${horaInicio}h às ${horaFim}h)`);
    }

    const agora = new Date();
    const dataHoraAgendamento = new Date(`${data}T${hora}:00`);
    if (dataHoraAgendamento < agora) {
      throw new Error("Não é possível agendar no passado");
    }

    const agendamentosAtivos = await Agendamento.countDocuments({ sender });
    if (agendamentosAtivos >= 3) {
      return "Você atingiu o limite de 3 agendamentos. Cancele um para agendar novamente.\n\n" + mostrarMenu();
    }

    const agendamentoExistente = await Agendamento.findOne({ data, hora });
    if (agendamentoExistente) {
      return "Horário já agendado. Escolha outro horário.\n\n" + listarHorarios(sender);
    }

    const agendamento = new Agendamento({
      nome,
      data,
      hora,
      sender,
      timestamp: new Date().toISOString()
    });
    await agendamento.save();
    logger.info(`Agendamento criado: ${nome}, ${data}, ${hora}, ${sender}`);
    await notificarAdmin(client, `Novo agendamento: ${nome}, ${data}, ${hora}`);
    await client.sendMessage(sender, await listarAgendamentosDia(sender, data));
    await client.sendMessage(
      sender,
      `*Agendamento Confirmado! 🎉*\nNome: ${nome}\nData: ${data}\nHora: ${hora}\nEndereço: ${INFO.endereco}\n\nChegue 5 minutos antes! Qualquer dúvida, é só chamar.`
    );
    ultimoAgendamento = { sender, timestamp: Date.now() };
    return null;
  } catch (e) {
    logger.error(`Erro em agendarServico: ${e.message}`);
    return `Erro: ${e.message}. Tente novamente.\n\n` + listarHorarios(sender);
  }
}

async function cancelarServico(nome, data, hora, client) {
  const agendamento = await Agendamento.findOne({ nome, data, hora });
  if (!agendamento) {
    return "Agendamento não encontrado.\n\n" + mostrarMenu();
  }
  await Agendamento.deleteOne({ nome, data, hora });
  const cancelamento = new Cancelamento({
    nome,
    data,
    hora,
    motivo: "Cancelado pelo usuário",
    timestamp: new Date().toISOString()
  });
  await cancelamento.save();
  logger.info(`Agendamento cancelado: ${nome}, ${data}, ${hora}`);
  await notificarAdmin(client, `Cancelamento: ${nome}, ${data}, ${hora}`);
  return "Agendamento cancelado com sucesso.\n\n" + mostrarMenu();
}

async function enviarLembrete(client) {
  const hoje = new Date().toISOString().split('T')[0];
  const agendamentos = await Agendamento.find({ data: hoje });
  for (const agendamento of agendamentos) {
    await client.sendMessage(
      agendamento.sender,
      `Lembrete: ${agendamento.nome}, seu corte é hoje às ${agendamento.hora}! 😎`
    );
    logger.info(`Lembrete enviado: ${agendamento.nome}, ${agendamento.hora}`);
  }
  return "Lembretes enviados.\n\n" + mostrarMenu();
}

async function coletarFeedback(nome, comentario, avaliacao) {
  if (!Number.isInteger(parseInt(avaliacao)) || avaliacao < 1 || avaliacao > 5) {
    return "Avaliação inválida. Use um número de 1 a 5.\n\nFormato: feedback [nome] [comentario] [avaliação]\n\n" + mostrarMenu();
  }
  const feedback = new Feedback({
    nome,
    comentario,
    avaliacao,
    timestamp: new Date().toISOString()
  });
  await feedback.save();
  logger.info(`Feedback coletado: ${nome}, ${comentario}, ${avaliacao} estrelas`);
  return "Valeu pelo feedback, irmão! 😎\n\n" + mostrarMenu();
}

async function gerarRelatorio(sender) {
  if (sender !== ADMIN_PHONE) {
    return "Apenas o administrador pode acessar relatórios.\n\n" + mostrarMenu();
  }
  const hoje = new Date().toISOString().split('T')[0];
  const agendamentos = await Agendamento.find({ data: { $gte: hoje } });
  const cancelamentos = await Cancelamento.find();
  const totalAgendamentos = agendamentos.length;
  const csv = "nome,data,hora\n" + agendamentos.map(a => `${a.nome},${a.data},${a.hora}`).join("\n");
  const csvCancel = "nome,data,hora,motivo\n" + cancelamentos.map(c => `${c.nome},${c.data},${c.hora},${c.motivo}`).join("\n");
  logger.info("Relatório de Agendamentos:\n" + csv);
  logger.info("Relatório de Cancelamentos:\n" + csvCancel);
  return `Relatório: ${totalAgendamentos} agendamentos ativos, ${cancelamentos.length} cancelados.\n\n${mostrarMenu()}`;
}

function iniciarChatChocolate(sender, client) {
  conversasChocolate.set(sender, {
    ativo: true,
    ultimoContato: Date.now(),
    timeoutId: setTimeout(() => {
      if (conversasChocolate.has(sender)) {
        client.sendMessage(sender, "Inatividade detectada. Encerrando o bate-papo.\n\n" + mostrarMenu());
        conversasChocolate.delete(sender);
        logger.info(`Bate-papo com Chocolate encerrado por inatividade: ${sender}`);
      }
    }, 7 * 60 * 1000)
  });
  logger.info(`Bate-papo com Chocolate iniciado: ${sender}`);
  return "O Chocolate foi solicitado, por favor, aguarde... ⏳\nDigite 'sair' a qualquer momento para finalizar o bate-papo e voltar ao menu.";
}

function processarMensagemChocolate(mensagem, sender, client) {
  const conversa = conversasChocolate.get(sender);
  if (!conversa || !conversa.ativo) return null;
  if (mensagem.toLowerCase().trim() === "sair") {
    clearTimeout(conversa.timeoutId);
    conversasChocolate.delete(sender);
    logger.info(`Bate-papo com Chocolate encerrado: ${sender}`);
    return "Bate-papo encerrado. Voltando ao menu.\n\n" + mostrarMenu();
  }
  clearTimeout(conversa.timeoutId);
  conversa.ultimoContato = Date.now();
  conversa.timeoutId = setTimeout(() => {
    if (conversasChocolate.has(sender)) {
      client.sendMessage(sender, "Inatividade detectada. Encerrando o bate-papo.\n\n" + mostrarMenu());
      conversasChocolate.delete(sender);
      logger.info(`Bate-papo com Chocolate encerrado por inatividade: ${sender}`);
    }
  }, 7 * 60 * 1000);
  return null;
}

async function processarMensagem(mensagem, sender, client) {
  if (!sender.endsWith('@c.us')) {
    logger.warn(`Mensagem ignorada: ${sender} não é um número válido.`);
    return null;
  }

  const estado = getEstado(sender);
  estado.ultimoContato = Date.now();
  const mensagemLower = mensagem.toLowerCase().trim();

  if (ultimoAgendamento && ultimoAgendamento.sender === sender && (Date.now() - ultimoAgendamento.timestamp) < 60000) {
    ultimoAgendamento = null;
    return mostrarMenu();
  }

  if (conversasChocolate.has(sender)) {
    const respostaChocolate = processarMensagemChocolate(mensagem, sender, client);
    if (respostaChocolate) return respostaChocolate;
    return null;
  }

  if (mensagemLower === "sair" && estado.etapa) {
    estados.delete(sender);
    return mostrarMenu();
  }

  if (!estado.etapa && !["1", "2", "3", "4", "5", "6", "7"].includes(mensagem) && !mensagemLower.startsWith("triagem") && !mensagemLower.startsWith("feedback") && !mensagemLower.startsWith("relatorio")) {
    return mostrarMenu();
  }

  if (mensagem === "1") {
    estado.etapa = "data";
    return "Digite a data do agendamento (DD/MM/YYYY) ou 'sair' para voltar ao menu:";
  } else if (mensagem === "2") {
    estado.etapa = "cancelar_nome_hora";
    return "Digite seu nome e o horário (ex.: Joao 09:00) ou 'sair' para voltar ao menu:";
  } else if (mensagem === "3") {
    return await listarAgendamentosDia(sender);
  } else if (mensagem === "4") {
    return INFO.horario + "\n\n" + mostrarMenu();
  } else if (mensagem === "5") {
    return INFO.endereco + "\n\n" + mostrarMenu();
  } else if (mensagem === "6") {
    return iniciarChatChocolate(sender, client);
  } else if (mensagem === "7") {
    if (conversasChocolate.has(sender)) {
      clearTimeout(conversasChocolate.get(sender).timeoutId);
      conversasChocolate.delete(sender);
    }
    estados.delete(sender);
    return "Bot encerrado. Até a próxima! 😎";
  }

  if (estado.etapa) {
    if (estado.etapa === "data") {
      if (!validarData(mensagem)) {
        return "Formato inválido. Use: DD/MM/YYYY (ex.: 25/12/2025)\n\nDigite novamente ou 'sair':";
      }
      const [dia, mes, ano] = mensagem.split('/');
      const dataObj = new Date(parseInt(ano), parseInt(mes) - 1, parseInt(dia));
      dataObj.setHours(0, 0, 0, 0);
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      if (dataObj < hoje) {
        return "A data deve ser hoje ou futura. Não é possível agendar no passado.\n\nDigite outra data (DD/MM/YYYY) ou 'sair':";
      }
      estado.data = `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
      estado.etapa = "horario";
      const diaSemana = dataObj.getDay();
      const [horaInicio, horaFim] = diaSemana === 6 ? [10, 16] : [9, 20];
      let horarios = [];
      let currentTime = new Date(dataObj);
      currentTime.setHours(horaInicio, 0, 0, 0);
      const fimTime = new Date(dataObj);
      fimTime.setHours(horaFim, 0, 0, 0);
      const rows = await Agendamento.find({ data: estado.data });
      while (currentTime < fimTime) {
        const horaStr = currentTime.toTimeString().slice(0, 5);
        const agendado = rows.find(a => a.hora === horaStr);
        const isAdmin = sender === ADMIN_PHONE;
        const status = agendado
          ? `⏰ (agendado${isAdmin ? ` - ${agendado.nome}` : ''})`
          : "✅ (disponível)";
        horarios.push(`${horaStr} ${status}`);
        currentTime.setMinutes(currentTime.getMinutes() + 30);
      }
      return horarios.join("\n") + "\n\nDigite o horário (ex.: 09:00) ou 'sair':";
    } else if (estado.etapa === "horario") {
      if (!validarHorario(mensagem)) {
        return "Horário inválido. Use: HH:MM (ex.: 09:00)\n\n" + listarHorarios(sender);
      }
      estado.hora = mensagem;
      estado.etapa = "nome";
      return "Digite seu nome ou 'sair' para voltar ao menu:";
    } else if (estado.etapa === "nome") {
      const nome = mensagem;
      const data = estado.data;
      const hora = estado.hora;
      estados.delete(sender);
      return await agendarServico(nome, data, hora, sender, client);
    } else if (estado.etapa === "cancelar_nome_hora") {
      const partes = mensagem.split(" ");
      if (partes.length >= 2) {
        const nome = partes[0];
        const hora = partes[1];
        if (!validarHorario(hora)) {
          return "Formato inválido. Use: [nome] [horário: HH:MM] (ex.: Joao 09:00) ou 'sair' para voltar ao menu:";
        }
        const data = new Date().toISOString().split('T')[0];
        estados.delete(sender);
        return await cancelarServico(nome, data, hora, client);
      }
      return "Formato: [nome] [horário: HH:MM] (ex.: Joao 09:00) ou 'sair' para voltar ao menu:";
    } else if (estado.etapa === "confirmar_presenca") {
      if (mensagemLower === "sim") {
        estados.delete(sender);
        return "Show! Te esperamos no horário. 😎\n\n" + mostrarMenu();
      } else if (mensagemLower === "não") {
        const { nome, data, hora } = estado.agendamento;
        estados.delete(sender);
        return await cancelarServico(nome, data, hora, client);
      }
      return "Responda 'Sim' ou 'Não' para confirmar sua presença.";
    }
  }

  if (mensagemLower.startsWith("triagem")) {
    const partes = mensagem.split(" ");
    if (partes.length >= 3) {
      const estilo = partes[1];
      const nome = partes[2];
      return triagemEstilo(estilo, nome);
    }
    return "Formato: triagem [estilo] [nome]\n\n" + mostrarMenu();
  } else if (mensagemLower.startsWith("feedback")) {
    const partes = mensagem.split(" ");
    if (partes.length >= 4) {
      const nome = partes[1];
      const avaliacao = parseInt(partes[partes.length - 1]);
      const comentario = partes.slice(2, -1).join(" ");
      return await coletarFeedback(nome, comentario, avaliacao);
    }
    return "Formato: feedback [nome] [comentario] [avaliação de 1 a 5]\n\n" + mostrarMenu();
  } else if (mensagemLower === "relatorio") {
    return await gerarRelatorio(sender);
  }

  return mostrarMenu();
}

// Configuração do WhatsApp
const client = new Client({
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ],
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome'
  }
});

client.on('qr', async qr => {
  const qrImage = await qrcode.toDataURL(qr);
  sessions['admin'] = { client, qr: qrImage };
  logger.info('QR Code gerado!');
});

client.on('ready', () => {
  logger.info('Bot da Barbearia Iniciado!');
  enviarLembrete(client);
});

client.on('disconnected', reason => {
  logger.error(`Cliente desconectado: ${reason}`);
  client.initialize().catch(err => logger.error(`Erro ao reiniciar cliente: ${err.message}`));
});

client.on('error', err => {
  logger.error(`Erro no cliente WhatsApp: ${err.message}`);
});

client.initialize().catch(err => {
  logger.error(`Erro ao inicializar o cliente: ${err.message}`);
  process.exit(1);
});

// Lembretes automáticos às 9h
cron.schedule('0 9 * * *', () => {
  const amanha = new Date();
  amanha.setDate(amanha.getDate() + 1);
  const dataAmanha = amanha.toISOString().split('T')[0];
  Agendamento.find({ data: dataAmanha }).then(rows => {
    for (const agendamento of rows) {
      client.sendMessage(
        agendamento.sender,
        `Lembrete: ${agendamento.nome}, seu corte é amanhã (${dataAmanha}) às ${agendamento.hora}! Confirme com 'Sim' ou 'Não'.`
      );
      const estado = getEstado(agendamento.sender);
      estado.etapa = "confirmar_presenca";
      estado.agendamento = { nome: agendamento.nome, data: dataAmanha, hora: agendamento.hora };
      logger.info(`Lembrete automático enviado: ${agendamento.nome}, ${dataAmanha}, ${agendamento.hora}`);
    }
  }).catch(err => logger.error(`Erro ao enviar lembretes automáticos: ${err.message}`));
});

// Limpeza de agendamentos antigos
cron.schedule('0 0 * * *', () => {
  const dataLimite = new Date();
  dataLimite.setDate(dataLimite.getDate() - 30);
  const dataLimiteStr = dataLimite.toISOString().split('T')[0];
  Agendamento.deleteMany({ data: { $lt: dataLimiteStr } })
    .then(() => logger.info(`Agendamentos antigos (antes de ${dataLimiteStr}) removidos.`))
    .catch(err => logger.error(`Erro ao limpar agendamentos antigos: ${err.message}`));
});

// Endpoints da API
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  const user = new User({ username, password: hashedPassword });
  await user.save();
  res.status(201).json({ message: 'Usuário registrado' });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (user && await bcrypt.compare(password, user.password)) {
    const token = jwt.sign({ username }, process.env.JWT_SECRET || 'minha-chave-secreta', { expiresIn: '1h' });
    res.json({ token });
  } else {
    res.status(401).json({ message: 'Usuário ou senha errados' });
  }
});

const authenticate = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token não fornecido' });
  jwt.verify(token, process.env.JWT_SECRET || 'minha-chave-secreta', (err, user) => {
    if (err) return res.status(403).json({ message: 'Token inválido' });
    req.user = user;
    next();
  });
};

app.post('/bot/start', authenticate, async (req, res) => {
  if (sessions['admin']) {
    res.json({ message: 'Bot já iniciado', qr: sessions['admin'].qr });
  } else {
    res.json({ message: 'Aguardando QR code' });
  }
});

app.post('/bot/message', authenticate, async (req, res) => {
  const { message, sender } = req.body;
  const resposta = await processarMensagem(message, sender, client);
  if (resposta) {
    await client.sendMessage(sender, resposta);
    res.json({ message: resposta });
  } else {
    res.json({ message: 'Aguardando resposta' });
  }
});

// Iniciar servidor após conexão com MongoDB
mongoose.connection.once('open', () => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => logger.info(`Servidor rodando na porta ${PORT}`));
});

// Encerrar cliente e banco de dados
process.on('SIGINT', async () => {
  await client.destroy();
  mongoose.connection.close();
  logger.info('MongoDB e cliente WhatsApp encerrados.');
  process.exit(0);
});