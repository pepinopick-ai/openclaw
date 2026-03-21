# RestoBot — Onboarding Checklist

## Pre-onboarding (antes de la reunion)

- [ ] Nombre del restaurante
- [ ] Contacto principal (nombre + WhatsApp)
- [ ] Plan elegido (starter/pro/enterprise)
- [ ] Direccion (para visitas)

## Reunion de setup (15-30 min)

- [ ] Explicar que hace RestoBot (3 minutos max)
- [ ] Obtener menu completo (foto/PDF/dictado)
- [ ] Obtener costos de ingredientes principales
- [ ] Definir horarios de alertas (manana? tarde?)
- [ ] Configurar canal de comunicacion (WhatsApp/Telegram)

## Configuracion tecnica (Roman, 30-60 min)

- [ ] Crear tenant: `node horeca-engine.cjs create "NOMBRE" "TELEFONO" PLAN`
- [ ] Cargar menu en hoja "Menu" del Google Sheet
- [ ] Cargar costos en hoja "Inventario"
- [ ] Configurar alertas Telegram/WhatsApp
- [ ] Test: enviar primer reporte de prueba
- [ ] Confirmar recepcion con el cliente

## Dia 1-3: Acompanamiento

- [ ] Llamar al cliente para confirmar que recibio los reportes
- [ ] Responder dudas
- [ ] Ajustar frecuencia de alertas si es necesario

## Semana 1: Review

- [ ] Revisar datos cargados (hay suficiente para analisis?)
- [ ] Enviar primer insight real ("Tu plato X tiene margen negativo")
- [ ] Pedir feedback

## Dia 25-28: Conversion

- [ ] Enviar resumen de valor entregado en 30 dias
- [ ] Proponer plan de pago
- [ ] Activar facturacion (MercadoPago)

## Metricas de exito del piloto

- Merma reducida en X%
- Margen promedio mejorado en X%
- Ahorro estimado en ARS
- NPS del cliente (1-10)
