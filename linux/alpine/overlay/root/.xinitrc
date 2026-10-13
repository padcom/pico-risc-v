# What startx starts: twm (~/.twmrc), and a terminal; closing that ends X.
twm &
exec xterm -geometry 100x30+40+40
