# CoopexCam

Sistema web de reunião para cooperativa, com:
- login admin fixo: `coopex` / `05289`
- sala por link/código para cooperado
- câmera e microfone no navegador
- pedir fala
- destaque por fala
- votação
- histórico
- exclusão de sala
- exportação PDF/Excel

## Rodar localmente

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Acesse `http://127.0.0.1:5000`

## Deploy no Render

Use o `render.yaml` do projeto e configure um banco PostgreSQL se quiser persistência fora do SQLite local.
