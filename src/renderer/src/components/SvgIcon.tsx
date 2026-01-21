import PropTypes from 'prop-types'
import { ReactElement } from 'react'

/**
 * @description: svg图标组件
 * @param {String} name 图标名称
 * @param size
 * @param color
 * @return {ReactElement}
 */

const SvgIcon = ({
  name,
  size = 15,
  color = 'rgb(216, 218, 218)'
}: {
  name: string
  size?: number
  color?: string
}): ReactElement => {
  return (
    <svg aria-hidden="true" style={{ width: size, height: size }}>
      <use xlinkHref={`#icon-${name}`} fill={color}></use>
    </svg>
  )
}

SvgIcon.propTypes = {
  name: PropTypes.string.isRequired,
  size: PropTypes.number,
  color: PropTypes.string
}
export default SvgIcon
