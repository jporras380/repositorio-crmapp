-- Reversa de 0021. El catálogo del hotel es aditivo: nada anterior depende de
-- él. Se pierden los tipos, habitaciones, tarifas y servicios configurados.
DROP TABLE IF EXISTS hotel_services;
DROP TABLE IF EXISTS rates;
DROP TABLE IF EXISTS rooms;
DROP TABLE IF EXISTS room_types;
