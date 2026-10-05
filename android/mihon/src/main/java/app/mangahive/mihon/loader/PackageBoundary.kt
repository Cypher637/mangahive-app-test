package app.mangahive.mihon.loader

/**
 * Exact package-boundary matching. A class is inside a boundary only if its PACKAGE equals an exact entry or is the
 * same as / a dot-separated descendant of a tree entry. Matching walks package segments, never raw string prefixes,
 * so tree("okhttp3") admits "okhttp3.internal.X" but not "okhttp3evil.X", and tree("a.b") never admits "a.bc.X".
 * Malformed names (default package, empty segments, slashes, arrays, whitespace) are never allowed.
 */
class PackageBoundary private constructor(
    private val exactPackages: Set<String>,
    private val packageTrees: Set<String>,
) {
    fun allows(className: String): Boolean {
        val pkg = packageOf(className) ?: return false
        return matches(pkg)
    }

    fun allowsPackage(pkg: String): Boolean = isValidPackage(pkg) && matches(pkg)

    private fun matches(pkg: String): Boolean {
        if (pkg in exactPackages) return true
        var p = pkg
        while (true) {
            if (p in packageTrees) return true
            val i = p.lastIndexOf('.')
            if (i < 0) return false
            p = p.substring(0, i)
        }
    }

    class Builder {
        private val exact = LinkedHashSet<String>()
        private val trees = LinkedHashSet<String>()
        fun exact(vararg packages: String) = apply { packages.forEach { require(isValidPackage(it)) { "bad package: $it" }; exact += it } }
        fun tree(vararg packages: String) = apply { packages.forEach { require(isValidPackage(it)) { "bad package: $it" }; trees += it } }
        fun build() = PackageBoundary(exact.toSet(), trees.toSet())
    }

    companion object {
        private val SEGMENT = Regex("[A-Za-z_$][A-Za-z0-9_$]*")
        val NONE: PackageBoundary = Builder().build()

        fun builder() = Builder()

        fun isValidPackage(pkg: String): Boolean = pkg.isNotEmpty() && pkg.split('.').all { SEGMENT.matches(it) }

        fun isValidClassName(name: String): Boolean {
            val i = name.lastIndexOf('.')
            return i > 0 && isValidPackage(name.substring(0, i)) && SEGMENT.matches(name.substring(i + 1))
        }

        /** Package of a well-formed binary class name (inner classes keep their outer package), else null. */
        fun packageOf(className: String): String? =
            if (isValidClassName(className)) className.substring(0, className.lastIndexOf('.')) else null
    }
}
