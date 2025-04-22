require('dotenv').config();
const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const winston = require('winston');

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

// Inicialização do banco de dados SQLite
const db = new sqlite3.Database('barbearia.db', (err) => {
  if (err) {
    logger.error(`Erro ao conectar ao banco de dados: ${err.message}`);
    process.exit(1);
  }
  logger.info('Conectado ao banco de dados SQLite.');
});

// Criar tabelas
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS agendamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT,
    data TEXT,
    hora TEXT,
    sender TEXT,
    timestamp TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS feedbacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT,
    comentario TEXT,
    avaliacao INTEGER,
    timestamp TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS cancelamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT,
    data TEXT,
    hora TEXT,
    motivo TEXT,
    timestamp TEXT
  )`);
});

// Configurações da barbearia
const ADMIN_PHONE = process.env.ADMIN_PHONE || '+5582993230395@c.us';
const INFO = {
  horario: "Seg a Sáb: 9h às 20h, Dom: 10h às 16h.",
  endereco: "Rua dos Cortes, 456, Bairro Estilo, Cidade."
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

/**
 * Exibe o menu principal do bot.
 * @returns {string} Menu formatado.
 */
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

/**
 * Lista horários disponíveis para uma data específica.
 * @param {string} sender - ID do usuário no WhatsApp.
 * @returns {string} Mensagem com horários disponíveis.
 */
function listarHorarios(sender) {
  const estado = getEstado(sender);
  estado.etapa = "data";
  return "Digite a data do agendamento (DD/MM/YYYY) ou 'sair' para voltar ao menu:";
}

/**
 * Lista agendamentos de um dia específico.
 * @param {string} sender - ID do usuário no WhatsApp.
 * @param {string} [data] - Data no formato YYYY-MM-DD.
 * @returns {Promise<string>} Lista de agendamentos formatada.
 */
function listarAgendamentosDia(sender, data = null) {
  const hoje = data || new Date().toISOString().split('T')[0];
  const diaSemana = new Date(hoje).getDay();
  const [horaInicio, horaFim] = diaSemana === 6 ? [10, 16] : [9, 20];
  let horarios = [];
  let currentTime = new Date(`${hoje}T${horaInicio.toString().padStart(2, '0')}:00:00`);
  const fimTime = new Date(`${hoje}T${horaFim.toString().padStart(2, '0')}:00:00`);

  return new Promise((resolve) => {
    db.all(`SELECT * FROM agendamentos WHERE data = ?`, [hoje], (err, rows) => {
      if (err) {
        logger.error(`Erro ao listar agendamentos: ${err.message}`);
        resolve("Erro ao listar agendamentos.\n\n" + mostrarMenu());
      }
      while (currentTime < fimTime) {
        const horaStr = currentTime.toTimeString().slice(0, 5);
        const agendado = rows.find((a) => a.hora === horaStr);
        const isAdmin = sender === ADMIN_PHONE;
        const status = agendado
          ? `⏰ (agendado${isAdmin ? ` - ${agendado.nome}` : ''})`
          : "✅ (disponível)";
        horarios.push(`${horaStr} ${status}`);
        currentTime.setMinutes(currentTime.getMinutes() + 30);
      }
      resolve(horarios.join("\n") + "\n\n" + mostrarMenu());
    });
  });
}

/**
 * Sugere um estilo de corte e inicia agendamento.
 * @param {string} estilo - Estilo desejado.
 * @param {string} nome - Nome do cliente.
 * @returns {string} Sugestão de estilo e menu.
 */
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

/**
 * Agenda um serviço na barbearia.
 * @param {string} nome - Nome do cliente.
 * @param {string} data - Data do agendamento (YYYY-MM-DD).
 * @param {string} hora - Horário do agendamento (HH:MM).
 * @param {string} sender - ID do usuário no WhatsApp.
 * @param {object} client - Instância do cliente WhatsApp.
 * @returns {Promise<string|null>} Mensagem de resposta ou null.
 */
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

    // Validação para evitar agendamentos no passado
    const agora = new Date();
    const dataHoraAgendamento = new Date(`${data}T${hora}:00`);
    logger.info(`Agendamento para ${dataHoraAgendamento.toISOString()}, agora é ${agora.toISOString()}`);
    if (dataHoraAgendamento < agora) {
      throw new Error("Não é possível agendar no passado");
    }

    // Verificar limite de agendamentos (máximo 3 por usuário)
    const agendamentosAtivos = await new Promise((resolve) => {
      db.all(`SELECT * FROM agendamentos WHERE sender = ?`, [sender], (err, rows) => {
        resolve(rows ? rows.length : 0);
      });
    });
    if (agendamentosAtivos >= 3) {
      return "Você atingiu o limite de 3 agendamentos. Cancele um para agendar novamente.\n\n" + mostrarMenu();
    }

    // Verificar se o horário está disponível
    return new Promise((resolve) => {
      db.get(
        `SELECT * FROM agendamentos WHERE data = ? AND hora = ?`,
        [data, hora],
        async (err, row) => {
          if (err) {
            logger.error(`Erro ao verificar agendamento: ${err.message}`);
            resolve("Erro ao verificar agendamento.\n\n" + mostrarMenu());
          }
          if (row) {
            resolve("Horário já agendado. Escolha outro horário.\n\n" + listarHorarios(sender));
          } else {
            // Inserir agendamento
            db.run(
              `INSERT INTO agendamentos (nome, data, hora, sender, timestamp) VALUES (?, ?, ?, ?, ?)`,
              [nome, data, hora, sender, new Date().toISOString()],
              async (err) => {
                if (err) {
                  logger.error(`Erro ao salvar agendamento: ${err.message}`);
                  resolve("Erro ao salvar agendamento.\n\n" + mostrarMenu());
                } else {
                  logger.info(`Agendamento criado: ${nome}, ${data}, ${hora}, ${sender}`);
                  await notificarAdmin(client, `Novo agendamento: ${nome}, ${data}, ${hora}`);
                  await client.sendMessage(sender, listarAgendamentosDia(sender, data));
                  await client.sendMessage(
                    sender,
                    `*Agendamento Confirmado! 🎉*\nNome: ${nome}\nData: ${data}\nHora: ${hora}\nEndereço: ${INFO.endereco}\n\nChegue 5 minutos antes! Qualquer dúvida, é só chamar.`
                  );
                  ultimoAgendamento = { sender, timestamp: Date.now() };
                  resolve(null);
                }
              }
            );
          }
        }
      );
    });
  } catch (e) {
    logger.error(`Erro em agendarServico: ${e.message}`);
    return `Erro: ${e.message}. Tente novamente.\n\n` + listarHorarios(sender);
  }
}

/**
 * Cancela um agendamento.
 * @param {string} nome - Nome do cliente.
 * @param {string} data - Data do agendamento (YYYY-MM-DD).
 * @param {string} hora - Horário do agendamento (HH:MM).
 * @param {object} client - Instância do cliente WhatsApp.
 * @returns {Promise<string>} Mensagem de confirmação ou erro.
 */
function cancelarServico(nome, data, hora, client) {
  return new Promise((resolve) => {
    db.get(
      `SELECT * FROM agendamentos WHERE nome = ? AND data = ? AND hora = ?`,
      [nome, data, hora],
      (err, row) => {
        if (err) {
          logger.error(`Erro ao verificar agendamento: ${err.message}`);
          resolve("Erro ao cancelar agendamento.\n\n" + mostrarMenu());
        }
        if (!row) {
          resolve("Agendamento não encontrado.\n\n" + mostrarMenu());
        } else {
          db.run(
            `DELETE FROM agendamentos WHERE nome = ? AND data = ? AND hora = ?`,
            [nome, data, hora],
            (err) => {
              if (err) {
                logger.error(`Erro ao cancelar agendamento: ${err.message}`);
                resolve("Erro ao cancelar agendamento.\n\n" + mostrarMenu());
              } else {
                db.run(
                  `INSERT INTO cancelamentos (nome, data, hora, motivo, timestamp) VALUES (?, ?, ?, ?, ?)`,
                  [nome, data, hora, "Cancelado pelo usuário", new Date().toISOString()],
                  async (err) => {
                    if (err) {
                      logger.error(`Erro ao registrar cancelamento: ${err.message}`);
                    }
                    logger.info(`Agendamento cancelado: ${nome}, ${data}, ${hora}`);
                    await notificarAdmin(client, `Cancelamento: ${nome}, ${data}, ${hora}`);
                    resolve("Agendamento cancelado com sucesso.\n\n" + mostrarMenu());
                  }
                );
              }
            }
          );
        }
      }
    );
  });
}

/**
 * Envia lembretes para agendamentos do dia atual.
 * @param {object} client - Instância do cliente WhatsApp.
 * @returns {Promise<string>} Mensagem de confirmação.
 */
function enviarLembrete(client) {
  const hoje = new Date().toISOString().split('T')[0];
  return new Promise((resolve) => {
    db.all(`SELECT * FROM agendamentos WHERE data = ?`, [hoje], (err, rows) => {
      if (err) {
        logger.error(`Erro ao enviar lembretes: ${err.message}`);
        resolve("Erro ao enviar lembretes.\n\n" + mostrarMenu());
      }
      for (const agendamento of rows) {
        client.sendMessage(
          agendamento.sender,
          `Lembrete: ${agendamento.nome}, seu corte é hoje às ${agendamento.hora}! 😎`
        );
        logger.info(`Lembrete enviado: ${agendamento.nome}, ${agendamento.hora}`);
      }
      resolve("Lembretes enviados.\n\n" + mostrarMenu());
    });
  });
}

/**
 * Coleta feedback do cliente.
 * @param {string} nome - Nome do cliente.
 * @param {string} comentario - Comentário do cliente.
 * @param {number} avaliacao - Avaliação de 1 a 5.
 * @returns {string} Mensagem de confirmação.
 */
function coletarFeedback(nome, comentario, avaliacao) {
  if (!Number.isInteger(parseInt(avaliacao)) || avaliacao < 1 || avaliacao > 5) {
    return "Avaliação inválida. Use um número de 1 a 5.\n\nFormato: feedback [nome] [comentario] [avaliação]\n\n" + mostrarMenu();
  }
  db.run(
    `INSERT INTO feedbacks (nome, comentario, avaliacao, timestamp) VALUES (?, ?, ?, ?)`,
    [nome, comentario, avaliacao, new Date().toISOString()],
    (err) => {
      if (err) {
        logger.error(`Erro ao salvar feedback: ${err.message}`);
      }
    }
  );
  logger.info(`Feedback coletado: ${nome}, ${comentario}, ${avaliacao} estrelas`);
  return "Valeu pelo feedback, irmão! 😎\n\n" + mostrarMenu();
}

/**
 * Gera relatório de agendamentos e cancelamentos.
 * @returns {Promise<string>} Relatório formatado.
 */
function gerarRelatorio(sender) {
  if (sender !== ADMIN_PHONE) {
    return Promise.resolve("Apenas o administrador pode acessar relatórios.\n\n" + mostrarMenu());
  }
  const hoje = new Date().toISOString().split('T')[0];
  return new Promise((resolve) => {
    db.all(`SELECT * FROM agendamentos WHERE data >= ?`, [hoje], (err, agendamentos) => {
      if (err) {
        logger.error(`Erro ao gerar relatório de agendamentos: ${err.message}`);
        resolve("Erro ao gerar relatório.\n\n" + mostrarMenu());
      }
      db.all(`SELECT * FROM cancelamentos`, [], (err, cancelamentos) => {
        if (err) {
          logger.error(`Erro ao gerar relatório de cancelamentos: ${err.message}`);
          resolve("Erro ao gerar relatório.\n\n" + mostrarMenu());
        }
        const totalAgendamentos = agendamentos.length;
        const csv = "nome,data,hora\n" + agendamentos.map(a => `${a.nome},${a.data},${a.hora}`).join("\n");
        const csvCancel = "nome,data,hora,motivo\n" + cancelamentos.map(c => `${c.nome},${c.data},${c.hora},${c.motivo}`).join("\n");
        logger.info("Relatório de Agendamentos:\n" + csv);
        logger.info("Relatório de Cancelamentos:\n" + csvCancel);
        resolve(`Relatório: ${totalAgendamentos} agendamentos ativos, ${cancelamentos.length} cancelados.\n\n${mostrarMenu()}`);
      });
    });
  });
}

/**
 * Inicia o bate-papo manual com Chocolate.
 * @param {string} sender - ID do usuário no WhatsApp.
 * @param {object} client - Instância do cliente WhatsApp.
 * @returns {string} Mensagem de boas-vindas.
 */
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

/**
 * Processa mensagens durante o bate-papo com Chocolate.
 * @param {string} mensagem - Mensagem do usuário.
 * @param {string} sender - ID do usuário no WhatsApp.
 * @param {object} client - Instância do cliente WhatsApp.
 * @returns {string|null} Mensagem de resposta ou null.
 */
function processarMensagemChocolate(mensagem, sender, client) {
  const conversa = conversasChocolate.get(sender);
  if (!conversa || !conversa.ativo) {
    return null;
  }
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

/**
 * Processa mensagens recebidas do WhatsApp.
 * @param {string} mensagem - Mensagem do usuário.
 * @param {string} sender - ID do usuário no WhatsApp.
 * @param {object} client - Instância do cliente WhatsApp.
 * @returns {Promise<string|null>} Mensagem de resposta ou null.
 */
async function processarMensagem(mensagem, sender, client) {
  // Validação do sender
  if (!sender.endsWith('@c.us')) {
    logger.warn(`Mensagem ignorada: ${sender} não é um número válido.`);
    return null;
  }

  const estado = getEstado(sender);
  estado.ultimoContato = Date.now();
  const mensagemLower = mensagem.toLowerCase().trim();

  // Verifica se o usuário acabou de agendar
  if (ultimoAgendamento && ultimoAgendamento.sender === sender && (Date.now() - ultimoAgendamento.timestamp) < 60000) {
    ultimoAgendamento = null;
    return mostrarMenu();
  }

  // Verifica bate-papo com Chocolate
  if (conversasChocolate.has(sender)) {
    const respostaChocolate = processarMensagemChocolate(mensagem, sender, client);
    if (respostaChocolate) {
      return respostaChocolate;
    }
    return null;
  }

  // Verifica saída em qualquer etapa
  if (mensagemLower === "sair" && estado.etapa) {
    estados.delete(sender);
    return mostrarMenu();
  }

  // Exibe menu para opções inválidas
  if (!estado.etapa && !["1", "2", "3", "4", "5", "6", "7"].includes(mensagem) && !mensagemLower.startsWith("triagem") && !mensagemLower.startsWith("feedback") && !mensagemLower.startsWith("relatorio")) {
    return mostrarMenu();
  }

  // Opções do menu
  if (mensagem === "1") {
    estado.etapa = "data";
    return "Digite a data do agendamento (DD/MM/YYYY) ou 'sair' para voltar ao menu:";
  } else if (mensagem === "2") {
    estado.etapa = "cancelar_nome_hora";
    return "Digite seu nome e o horário (ex.: Joao 09:00) ou 'sair' para voltar ao menu:";
  } else if (mensagem === "3") {
    return listarAgendamentosDia(sender);
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

  // Processamento de etapas
  if (estado.etapa) {
    if (estado.etapa === "data") {
      if (!validarData(mensagem)) {
        return "Formato inválido. Use: DD/MM/YYYY (ex.: 25/12/2025)\n\nDigite novamente ou 'sair':";
      }
      const [dia, mes, ano] = mensagem.split('/');
      const dataObj = new Date(parseInt(ano), parseInt(mes) - 1, parseInt(dia));
      dataObj.setHours(0, 0, 0, 0); // Set to midnight local time
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      logger.info(`Tentativa de agendamento para ${dataObj.toISOString()}, hoje é ${hoje.toISOString()}`);
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
      return new Promise((resolve) => {
        db.all(`SELECT * FROM agendamentos WHERE data = ?`, [estado.data], (err, rows) => {
          if (err) {
            logger.error(`Erro ao listar horários: ${err.message}`);
            resolve("Erro ao listar horários.\n\n" + mostrarMenu());
          }
          while (currentTime < fimTime) {
            const horaStr = currentTime.toTimeString().slice(0, 5);
            const agendado = rows.find((a) => a.hora === horaStr);
            const isAdmin = sender === ADMIN_PHONE;
            const status = agendado
              ? `⏰ (agendado${isAdmin ? ` - ${agendado.nome}` : ''})`
              : "✅ (disponível)";
            horarios.push(`${horaStr} ${status}`);
            currentTime.setMinutes(currentTime.getMinutes() + 30);
          }
          resolve(horarios.join("\n") + "\n\nDigite o horário (ex.: 09:00) ou 'sair':");
        });
      });
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

  // Comandos especiais
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
      return coletarFeedback(nome, comentario, avaliacao);
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
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', // Ajuste o caminho para o Chrome instalado
    timeout: 60000, // 60 segundos
    args: ['--no-sandbox', '--disable-setuid-sandbox'] // Evita problemas de permissão
  }
});

client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
  logger.info('QR Code gerado! Escaneie com o WhatsApp.');
});

client.on('ready', () => {
  logger.info('Bot da Barbearia Iniciado!');
  enviarLembrete(client);
});

// Manipulação de erros do cliente WhatsApp
client.on('disconnected', (reason) => {
  logger.error(`Cliente desconectado: ${reason}`);
  client.initialize().catch((err) => logger.error(`Erro ao reiniciar cliente: ${err.message}`));
});

client.on('error', (err) => {
  logger.error(`Erro no cliente WhatsApp: ${err.message}`);
});

// Inicialização com tratamento de erro
client.initialize().catch((err) => {
  logger.error(`Erro ao inicializar o cliente: ${err.message}`);
  process.exit(1);
});

// Lembretes automáticos às 9h todos os dias
cron.schedule('0 9 * * *', () => {
  const amanha = new Date();
  amanha.setDate(amanha.getDate() + 1);
  const dataAmanha = amanha.toISOString().split('T')[0];
  db.all(`SELECT * FROM agendamentos WHERE data = ?`, [dataAmanha], (err, rows) => {
    if (err) {
      logger.error(`Erro ao enviar lembretes automáticos: ${err.message}`);
      return;
    }
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
  });
});

// Limpeza de agendamentos antigos (mais de 30 dias)
cron.schedule('0 0 * * *', () => {
  const dataLimite = new Date();
  dataLimite.setDate(dataLimite.getDate() - 30);
  const dataLimiteStr = dataLimite.toISOString().split('T')[0];
  db.run(`DELETE FROM agendamentos WHERE data < ?`, [dataLimiteStr], (err) => {
    if (err) {
      logger.error(`Erro ao limpar agendamentos antigos: ${err.message}`);
    } else {
      logger.info(`Agendamentos antigos (antes de ${dataLimiteStr}) removidos.`);
    }
  });
});

client.on('message', async (message) => {
  // Ignorar mensagens de grupos
  if (message.from.includes('@g.us')) {
    logger.info(`Mensagem de grupo ignorada: ${message.from}`);
    return;
  }

  // Ignorar mensagens de mídia
  if (message.hasMedia) {
    message.reply("Desculpe, só processamos mensagens de texto! 😅\n\n" + mostrarMenu());
    return;
  }

  logger.info(`Mensagem recebida de ${message.from}: ${message.body}`);
  const resposta = await processarMensagem(message.body, message.from, client);
  if (resposta !== null) {
    message.reply(resposta);
    logger.info(`Resposta enviada para ${message.from}: ${resposta}`);
  }
});

// Encerrar cliente e banco de dados ao fechar o processo
process.on('SIGINT', async () => {
  await client.destroy();
  db.close((err) => {
    if (err) {
      logger.error(`Erro ao fechar o banco de dados: ${err.message}`);
    }
    logger.info('Banco de dados fechado.');
    process.exit(0);
  });
});

module.exports = { validarHorario, validarData, coletarFeedback };