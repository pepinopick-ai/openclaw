# RestoBot — Plantillas de Mensajes

## Reporte diario (automatico, 10:00)

_RestoBot — [RESTAURANTE]_
Resumen de ayer ([FECHA]):

Ventas: $[TOTAL] ([+/-X]% vs promedio)
Platos vendidos: [N]
Top 3: [PLATO1], [PLATO2], [PLATO3]
Merma estimada: [X]% ($[MONTO])

[Si hay alertas:]
_Atencion:_

- [PLATO] tiene margen negativo (-[X]%)
- Stock bajo de [INGREDIENTE]

Necesitas algo? Responde este mensaje.

## Reporte semanal (automatico, lunes 09:00)

_RestoBot Semanal — [RESTAURANTE]_
Semana [DD/MM] al [DD/MM]:

Ventas totales: $[TOTAL]
vs semana anterior: [+/-X]%
Mejor dia: [DIA] ($[MONTO])
Peor dia: [DIA] ($[MONTO])

_Top 5 platos:_

1. [PLATO] — [N] vendidos, margen [X]%
2. ...

_Merma:_
Total: $[MONTO] ([X]% de compras)
Peor categoria: [CATEGORIA]

_Recomendacion:_
[INSIGHT automatico basado en datos]

## Alerta de merma (instantanea)

_RestoBot Alerta — [RESTAURANTE]_

Se detecto merma alta en [CATEGORIA]:

- [PRODUCTO]: [X] kg descartados (valor: $[MONTO])
- Causa probable: [sobrecompra/caducidad/preparacion]

Sugerencia: [reducir pedido / revisar porciones / cambiar proveedor]

## Alerta de margen (instantanea)

_RestoBot Alerta — [RESTAURANTE]_

El plato "[PLATO]" tiene margen por debajo del minimo:

- Precio de venta: $[PRECIO]
- Costo estimado: $[COSTO]
- Margen: [X]% (minimo recomendado: 65%)

Opciones:

1. Subir precio a $[SUGERIDO] (+[X]%)
2. Reducir porcion de [INGREDIENTE_CARO]
3. Buscar proveedor alternativo
