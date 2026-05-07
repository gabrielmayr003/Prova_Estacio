# Prova

Assistente local para ler uma prova propria no Firefox, gerar prompt, abrir o ChatGPT no Chrome normal e marcar alternativas.

## Como Rodar

```powershell
npm install
npm start
```

## Comandos

```text
site                 Abre https://estudante.estacio.br/disciplinas
prova <chave>        Abre a prova pela chave da URL
ler                  Le questoes visiveis
prompt               Gera/substitui prompt-prova.txt, cola no ChatGPT e tenta extrair respostas
aplicar              Le respostas.txt e marca alternativas
sair                 Fecha o navegador
```
