"""Join the spending-limit and package-registry migration histories."""

revision = "c16b8f42d903"
down_revision = ("b7c2e4d9f130", "b95ea4618c02")
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Preserve both independent schema changes at one migration head."""
    pass


def downgrade() -> None:
    """Return to both parent revisions without changing schema objects."""
    pass
