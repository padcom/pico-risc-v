#include "../terminal.h"

/*
 * CPU benchmark: a mix of the work real programs do (integer arithmetic and
 * multiplication, table lookups, branchy comparisons, byte-wise memory
 * access, calls). It prints a checksum, so an emulator that is faster but
 * wrong gets caught too.
 */

#define ROUNDS 36

/* --- matrix multiplication (multiply, loads, nested loops) ------------- */

#define N 24
int ma[N][N], mb[N][N], mc[N][N];

__attribute__((noinline))
static unsigned matmul(void) {
    for (int i = 0; i < N; i++)
        for (int j = 0; j < N; j++) {
            int sum = 0;
            for (int k = 0; k < N; k++)
                sum += ma[i][k] * mb[k][j];
            mc[i][j] = sum;
        }
    unsigned h = 0;
    for (int i = 0; i < N; i++)
        h = h * 31 + (unsigned)mc[i][(i * 7) % N];
    return h;
}

/* --- CRC-32 (table lookups, shifts, byte loads) ------------------------ */

static unsigned crc_table[256];
static unsigned char data[8192];

static void crc_init(void) {
    for (unsigned n = 0; n < 256; n++) {
        unsigned c = n;
        for (int k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320u ^ (c >> 1) : c >> 1;
        crc_table[n] = c;
    }
}

__attribute__((noinline))
static unsigned crc32(const unsigned char *p, unsigned len) {
    unsigned c = 0xffffffffu;
    while (len--)
        c = crc_table[(c ^ *p++) & 0xff] ^ (c >> 8);
    return c ^ 0xffffffffu;
}

/* --- quicksort (branches, recursion, stores) --------------------------- */

#define SORT_N 3000
static int values[SORT_N];
static unsigned seed;

static unsigned rnd(void) {
    seed = seed * 1103515245u + 12345u;
    return seed >> 8;
}

static void quicksort(int *v, int lo, int hi) {
    while (lo < hi) {
        int pivot = v[(lo + hi) / 2], i = lo, j = hi;
        while (i <= j) {
            while (v[i] < pivot) i++;
            while (v[j] > pivot) j--;
            if (i <= j) {
                int t = v[i];
                v[i++] = v[j];
                v[j--] = t;
            }
        }
        if (j - lo < hi - i) {
            quicksort(v, lo, j);
            lo = i;
        } else {
            quicksort(v, i, hi);
            hi = j;
        }
    }
}

__attribute__((noinline))
static unsigned sort(void) {
    for (int i = 0; i < SORT_N; i++)
        values[i] = (int)(rnd() % 100000) - 50000;
    quicksort(values, 0, SORT_N - 1);
    unsigned h = 0;
    for (int i = 1; i < SORT_N; i++) {
        if (values[i - 1] > values[i])
            return 0; /* not sorted: poison the checksum */
        h += (unsigned)values[i] * (unsigned)i;
    }
    return h;
}

/* --- string work (byte stores, division, small loops) ------------------ */

__attribute__((noinline))
static unsigned strings(void) {
    char buf[16];
    unsigned h = 5381;
    for (unsigned n = 0; n < 20000; n++) {
        unsigned v = n * 2654435761u, len = 0;
        do {
            buf[len++] = (char)('0' + v % 10);
            v /= 10;
        } while (v);
        for (unsigned i = 0; i < len; i++)
            h = h * 33 ^ (unsigned char)buf[i];
    }
    return h;
}

static void put_hex(unsigned v) {
    for (int shift = 28; shift >= 0; shift -= 4)
        term_putc("0123456789abcdef"[(v >> shift) & 15]);
}

int main(void) {
    seed = 42;
    for (int i = 0; i < N; i++)
        for (int j = 0; j < N; j++) {
            ma[i][j] = (int)(rnd() % 201) - 100;
            mb[i][j] = (int)(rnd() % 201) - 100;
        }
    for (unsigned i = 0; i < sizeof data; i++)
        data[i] = (unsigned char)rnd();
    crc_init();

    unsigned checksum = 0;
    for (int round = 0; round < ROUNDS; round++) {
        checksum = checksum * 7 + matmul();
        checksum = checksum * 7 + crc32(data, sizeof data);
        checksum = checksum * 7 + sort();
        checksum = checksum * 7 + strings();
    }
    term_puts("checksum ");
    put_hex(checksum);
    term_putc('\n');
    return 0;
}
