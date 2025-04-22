# Usa a imagem base do Node.js
FROM node:18

# Instala dependências do Chrome
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && apt-get clean

# Define o diretório de trabalho
WORKDIR /app

# Copia os arquivos do projeto
COPY . .

# Instala as dependências do Node.js
RUN npm install

# Define a variável de ambiente para o Chrome
ENV CHROME_PATH=/usr/bin/google-chrome

# Inicia a aplicação
CMD ["npm", "start"]