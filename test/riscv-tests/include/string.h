/* Stand-in for the C library header riscv-tests' env/v needs (the bare-metal
 * toolchain has no C library); env/v/string.c implements these. */
#ifndef STRING_H
#define STRING_H
#include <stddef.h>
void *memcpy(void *dest, const void *src, size_t len);
void *memset(void *dest, int byte, size_t len);
int memcmp(const void *s1, const void *s2, size_t n);
size_t strlen(const char *s);
int strcmp(const char *s1, const char *s2);
char *strcpy(char *dest, const char *src);
#endif
