package eu.kanade.tachiyomi.network

/** Thrown by [awaitSuccess] / [asObservableSuccess] for a non-2xx response (tachiyomix 1.6.0). */
class HttpException(val code: Int) : IllegalStateException("HTTP error $code")
