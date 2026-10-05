package app.mangahive.mihon.loader

import java.io.InputStream
import java.net.URL
import java.util.Collections
import java.util.Enumeration

/**
 * A ClassLoader that can only hand out classes admitted by one of its routes. It has NO parent: anything not
 * admitted is a ClassNotFoundException, never a silent fall-through to the application ClassLoader. Resources are
 * never served (they could leak host assets).
 */
class BoundaryClassLoader(private val routes: List<Route>) : ClassLoader(null) {

    /** [loader] == null means the platform/boot loader (framework classes). */
    class Route(val label: String, val allow: PackageBoundary, val deny: PackageBoundary, val loader: ClassLoader?) {
        fun permits(name: String) = allow.allows(name) && !deny.allows(name)
    }

    override fun loadClass(name: String, resolve: Boolean): Class<*> {
        var blocked = true
        for (r in routes) {
            if (!r.permits(name)) continue
            blocked = false
            try {
                return Class.forName(name, false, r.loader)
            } catch (_: ClassNotFoundException) {
                // try the next permitting route
            }
        }
        throw ClassNotFoundException(if (blocked) "$name: outside extension boundary" else "$name: not provided by ${routes.filter { it.permits(name) }.joinToString { it.label }}")
    }

    override fun getResource(name: String): URL? = null
    override fun getResources(name: String): Enumeration<URL> = Collections.emptyEnumeration()
    override fun getResourceAsStream(name: String): InputStream? = null
}
