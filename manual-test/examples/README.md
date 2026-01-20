# FlightPath Examples

This directory contains **educational examples** demonstrating FlightPath features. These are NOT tests - they are detailed, well-documented workflows showing best practices and advanced features.

## Directory Structure

- **workflow-properties/** - Examples of workflow-level property inheritance and precedence
- **sessions/** - Examples of session management patterns (multi-session, cross-provider, session reuse)

## Examples vs Tests

**Examples:**
- Comprehensive documentation in comments
- Demonstrate advanced features and edge cases
- May include complex real-world scenarios
- Not optimized for speed

**Tests (in parent directory):**
- Simple, fast execution
- Clear pass/fail indicators
- Minimal LLM complexity
- Optimized for quick validation

## Usage

Use these examples to learn how to structure your own workflows. They demonstrate:
- Property precedence (prompt > workflow > settings)
- Session management strategies
- End condition patterns
- Multi-provider workflows
